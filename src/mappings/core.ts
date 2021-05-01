/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, log, Value } from '@graphprotocol/graph-ts'
import {
  Pair,
  Token,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
  TransferPosition,
  User
} from '../types/schema'
import { Mint, Burn, Swap, Transfer, Sync } from '../types/templates/Pair/Pair'
import { getEthPriceInUSD, findEthPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ZERO_ADDRESS,
  ONE_BI,
  ZERO_BD,
  getUser,
  createLiquiditySnapshot,
  touchUser
} from './helpers'

function isCompleteMint(mintId: string): boolean {
  return MintEvent.load(mintId)!.sender !== null // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  const to = event.params.to
  if (to.equals(ZERO_ADDRESS) && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  const from = event.params.from
  const transactionHashId = event.transaction.hash.toHexString()

  // get pair and load contract
  const pairId = event.address.toHexString();
  const pair = Pair.load(pairId)!

  // liquidity token amount being transferred
  const value = convertTokenToDecimal(event.params.value, 18)

  // get or create transaction
  // TODO: Add optimization to not ask postgres
  let transaction = Transaction.load(transactionHashId)
  if (transaction === null) {
    transaction = new Transaction(transactionHashId)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.burns = []
    transaction.swaps = []
    transaction.touchedUsers = []
  }

  // mints
  const mints = transaction!.mintsValueArray
  const burns = transaction!.burnsValueArray
  if (from.equals(ZERO_ADDRESS)) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value)

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1]!.toString())) {
      const mint = new MintEvent(
          transactionHashId
          .concat('-')
          .concat(BigInt.fromI32(mints.length).toString())
      )
      mint.transaction = transactionHashId
      mint.pair = pairId
      mint.to = to
      mint.liquidity = value
      mint.timestamp = transaction.timestamp
      mint.save()

      // update mints in transaction
      mints.push(Value.fromString(mint.id));
    }
  }

  // case where direct send first on ETH withdrawls
  if (to.equals(event.address)) {
    let burn = new BurnEvent(
        transactionHashId
        .concat('-')
        .concat(BigInt.fromI32(burns.length).toString())
    )
    burn.transaction = transactionHashId
    burn.pair = pairId
    burn.liquidity = value
    burn.timestamp = transaction.timestamp
    burn.to = to
    burn.sender = from
    burn.needsComplete = true
    burn.save()

    burns.push(Value.fromString(burn.id))
  }

  // burn
  if (to.equals(ZERO_ADDRESS) && from.equals(event.address)) {
    pair.totalSupply = pair.totalSupply.minus(value)

    // this is a new instance of a logical burn
    let burn: BurnEvent
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1].toString())!
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent
      } else {
        burn = new BurnEvent(
            transactionHashId
            .concat('-')
            .concat(BigInt.fromI32(burns.length).toString())
        )
        burn.transaction = transactionHashId
        burn.needsComplete = false
        burn.pair = pairId
        burn.liquidity = value
        burn.timestamp = transaction.timestamp
      }
    } else {
      burn = new BurnEvent(
          transactionHashId
          .concat('-')
          .concat(BigInt.fromI32(burns.length).toString())
      )
      burn.transaction = transactionHashId
      burn.needsComplete = false
      burn.pair = pairId
      burn.liquidity = value
      burn.timestamp = transaction.timestamp
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1].toString())) {
      const mint = MintEvent.load(mints[mints.length - 1].toString())!
      burn.feeTo = mint.to
      burn.feeLiquidity = mint.liquidity
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1].toString())
      // update the transaction

      mints.pop()
    }
    burn.save()
    // if accessing last one, replace it
    if (burn.needsComplete) {
      burns[burns.length - 1] = Value.fromString(burn.id)
    }
    // else add new one
    else {
      burns.push(Value.fromString(burn.id))
    }
  }

  const toUser = getUser(to, pairId);
  const fromUser = getUser(from, pairId);
  const lpPosition = createLiquiditySnapshot(pair, event.block.timestamp, event.block.number);

  if (toUser != null) {
    toUser.balance = toUser.balance.plus(value);
    if (touchUser(transaction as Transaction, toUser as User)) {
      toUser.transactionsCount = toUser.transactionsCount.plus(ONE_BI);
    }
    lpPosition.user = toUser.id;
    lpPosition.liquidityTokenBalance = toUser.balance;
    lpPosition.id = toUser.id.concat(toUser.liquidityPositionsCount.toString());
    lpPosition.save();
    toUser.liquidityPositionsCount = toUser.liquidityPositionsCount.plus(ONE_BI);
  }

  if (fromUser != null) {
    fromUser.balance = fromUser.balance.minus(value);
    if (touchUser(transaction as Transaction, fromUser as User)) {
      fromUser.transactionsCount = fromUser.transactionsCount.plus(ONE_BI);
    }
    lpPosition.user = fromUser.id;
    lpPosition.liquidityTokenBalance = fromUser.balance;
    lpPosition.id = fromUser.id.concat(fromUser.liquidityPositionsCount.toString());
    lpPosition.save();
    fromUser.liquidityPositionsCount = fromUser.liquidityPositionsCount.plus(ONE_BI);
  }

  if (toUser != null && fromUser != null) {
    let transfer = new TransferPosition(fromUser.id.concat(toUser.id).concat(fromUser.lpTransfersCount.toString()));
    transfer.transaction = transactionHashId;
    transfer.timestamp = event.block.timestamp;
    transfer.blockNumber = event.block.number;
    transfer.from = fromUser.id;
    transfer.to = toUser.id;
    transfer.lpAmount = value;
    if (pair.totalSupply.notEqual(ZERO_BD)) {
      transfer.derivedUsdAmount = pair.reserveUSD.times(value).div(pair.totalSupply);
    } else {
      transfer.derivedUsdAmount = pair.reserveUSD.times(value);
    }
    transfer.pair = pairId;
    transfer.save();
    toUser.lpTransfersCount = toUser.lpTransfersCount.plus(ONE_BI);
    fromUser.lpTransfersCount = fromUser.lpTransfersCount.plus(ONE_BI);
  }

  if (toUser != null) {
    toUser.save()
  }
  if (fromUser != null) {
    fromUser.save()
  }
  pair.save()
  transaction.save()
}

export function handleSync(event: Sync): void {
  const pairId = event.address.toHex();
  const pair = Pair.load(pairId)!
  const token0 = Token.load(pair.token0)!
  const token1 = Token.load(pair.token1)!
  const bundle = Bundle.load('1')!

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1)

  const reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals.toI32());
  pair.reserve0 = reserve0
  const reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals.toI32())
  pair.reserve1 = reserve1

  if (reserve1.notEqual(ZERO_BD)) pair.token0Price = reserve0.div(reserve1)
  else pair.token0Price = ZERO_BD
  if (reserve0.notEqual(ZERO_BD)) pair.token1Price = reserve1.div(reserve0)
  else pair.token1Price = ZERO_BD

  pair.save()

  // update ETH price now that reserves could have changed
  const ethPrice = getEthPriceInUSD(pair)
  bundle.ethPrice = ethPrice

  const token0ETH = findEthPerToken(token0 as Token)
  token0.previousDerivedETH = token0.derivedETH
  token0.derivedETH = token0ETH
  const token1ETH = findEthPerToken(token1 as Token)
  token1.previousDerivedETH = token1.derivedETH
  token1.derivedETH = token1ETH

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityETH: BigDecimal
  if (ethPrice.notEqual(ZERO_BD)) {
    trackedLiquidityETH = getTrackedLiquidityUSD(ethPrice, token0.id, reserve0, token0ETH, token1.id, reserve1, token1ETH).div(ethPrice)
  } else {
    trackedLiquidityETH = ZERO_BD
  }

  // use derived amounts within pair
  pair.trackedReserveETH = trackedLiquidityETH
  const reserveETH = reserve0.times(token0ETH).plus(reserve1.times(token1ETH))
  pair.reserveETH = reserveETH
  pair.reserveUSD = reserveETH.times(ethPrice)

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(reserve0)
  token1.totalLiquidity = token1.totalLiquidity.plus(reserve1)

  // save entities
  pair.save()
  token0.save()
  token1.save()
  bundle.save()
}

export function handleMint(event: Mint): void {
  const sender = event.parameters[0].value.toAddress()
  const amount0 = event.parameters[1].value.toBigInt()
  const amount1 = event.parameters[2].value.toBigInt()
  const transaction = Transaction.load(event.transaction.hash.toHexString())!
  const mints = transaction.mintsValueArray
  const mint = MintEvent.load(mints[mints.length - 1].toString())!
  const pairId = event.address.toHex()
  const pair = Pair.load(pairId)!
  const token0 = Token.load(pair.token0)!
  const token1 = Token.load(pair.token1)!
  const bundle = Bundle.load('1')!
  const ethPrice = bundle.ethPrice

  // update exchange info (except balances, sync will cover that)
  const token0Amount = convertTokenToDecimal(amount0, token0.decimals.toI32())
  const token1Amount = convertTokenToDecimal(amount1, token1.decimals.toI32())

  // get new amounts of USD and ETH for tracking
  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(ethPrice)

  mint.sender = sender
  mint.amount0 = token0Amount as BigDecimal
  mint.amount1 = token1Amount as BigDecimal
  mint.logIndex = event.logIndex
  mint.amountUSD = amountTotalUSD as BigDecimal

  // save entities
  mint.save()
  token0.save()
  token1.save()
  pair.save()
}

export function handleBurn(event: Burn): void {
  const transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  const burns = transaction.burnsValueArray
  const burn = BurnEvent.load(burns[burns.length - 1].toString())!
  const pairId = event.address.toHex()
  const pair = Pair.load(pairId)!
  const bundle = Bundle.load('1')!
  const ethPrice = bundle.ethPrice

  //update token info
  const token0 = Token.load(pair.token0)!
  const token1 = Token.load(pair.token1)!
  const token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals.toI32())
  const token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals.toI32())

  // get new amounts of USD and ETH for tracking
  const amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(ethPrice)

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal
  burn.amount1 = token1Amount as BigDecimal
  // burn.to = event.params.to
  burn.logIndex = event.logIndex
  burn.amountUSD = amountTotalUSD as BigDecimal

  // update global counter and save
  token0.save()
  token1.save()
  pair.save()
  burn.save()
}

export function handleSwap(event: Swap): void {
  const pairId = event.address.toHexString()
  const pair = Pair.load(pairId)!
  const token0 = Token.load(pair.token0)!
  const token1 = Token.load(pair.token1)!
  const token0Decimal = token0.decimals.toI32()
  const token1Decimal = token1.decimals.toI32()
  const amount0In = convertTokenToDecimal(event.params.amount0In, token0Decimal)
  const amount1In = convertTokenToDecimal(event.params.amount1In, token1Decimal)
  const amount0Out = convertTokenToDecimal(event.params.amount0Out, token0Decimal)
  const amount1Out = convertTokenToDecimal(event.params.amount1Out, token1Decimal)
  const bundle = Bundle.load('1')!
  const ethPrice = bundle.ethPrice

  // totals for volume updates
  const amount0Total = amount0Out.plus(amount0In)
  const amount1Total = amount1Out.plus(amount1In)
  const token0ETH = token0.derivedETH;
  const token1ETH = token1.derivedETH;

  const usdInOld = amount0In.times(token0.previousDerivedETH).plus(amount1In.times(token1.previousDerivedETH)).times(ethPrice);
  const usdInNew = amount0In.times(token0ETH).plus(amount1In.times(token1ETH)).times(ethPrice);
  const usdOut = amount0Out.times(token0ETH).plus(amount1Out.times(token1ETH)).times(ethPrice);
  let user = getUser(event.transaction.from, pairId)!;
  user.feesUsdPaid = user.feesUsdPaid.plus(usdInOld.minus(usdOut));
  user.usdSwapped = user.usdSwapped.plus(usdInNew).plus(usdOut);

  // get total amounts of derived USD and ETH for tracking
  const derivedAmountETH = token1ETH
    .times(amount1Total)
    .plus(token0ETH.times(amount0Total))
    .div(BigDecimal.fromString('2'))
  const derivedAmountUSD = derivedAmountETH.times(ethPrice)

  // only accounts for volume through white listed tokens
  const trackedAmountUSD = getTrackedVolumeUSD(ethPrice, token0.id, amount0Total, token0ETH, token1.id, amount1Total, token1ETH)
  const transactionHashId = event.transaction.hash.toHexString()
  let transaction = Transaction.load(transactionHashId)
  if (transaction === null) {
    transaction = new Transaction(transactionHashId)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
    transaction.touchedUsers = []
    touchUser(transaction as Transaction, user as User)
    user.transactionsCount = user.transactionsCount.plus(ONE_BI)
  }
  const swaps = transaction.swapsValueArray
  const swap = new SwapEvent(
      transactionHashId
      .concat('-')
      .concat(BigInt.fromI32(swaps.length).toString())
  )

  // update swap event
  swap.transaction = transactionHashId
  swap.pair = pairId
  swap.timestamp = transaction.timestamp
  swap.sender = event.params.sender
  swap.amount0In = amount0In
  swap.amount1In = amount1In
  swap.amount0Out = amount0Out
  swap.amount1Out = amount1Out
  swap.to = event.params.to
  swap.from = event.transaction.from
  swap.logIndex = event.logIndex
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD
  swaps.push(Value.fromString(swap.id))

  pair.save()
  token0.save()
  token1.save()
  pair.save()
  swap.save()
  transaction.save()
  user.save()
}
