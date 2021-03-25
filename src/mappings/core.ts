/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, log } from '@graphprotocol/graph-ts'
import {
  Pair,
  Token,
  UniswapFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle
} from '../types/schema'
import { Mint, Burn, Swap, Transfer, Sync } from '../types/templates/Pair/Pair'
import { updatePairDayData, updateTokenDayData, updateUniswapDayData, updatePairHourData } from './dayUpdates'
import { getEthPriceInUSD, findEthPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ZERO_ADDRESS,
  FACTORY_ADDRESS_STRING,
  ONE_BI,
  ZERO_BD
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
  let pair = Pair.load(pairId)!

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
  }

  // mints
  const mints = transaction!.mints
  const burns = transaction!.burns
  if (from.equals(ZERO_ADDRESS)) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value)

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1]!)) {
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
      mints.push(mint.id);
    }
  }

  // case where direct send first on ETH withdrawls
  if (event.params.to.equals(event.address)) {
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

    burns.push(burn.id)
  }

  // burn
  if (event.params.to.equals(ZERO_ADDRESS) && event.params.from.equals(event.address)) {
    pair.totalSupply = pair.totalSupply.minus(value)

    // this is a new instance of a logical burn
    let burn: BurnEvent
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1])!
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
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      const mint = MintEvent.load(mints[mints.length - 1])!
      burn.feeTo = mint.to
      burn.feeLiquidity = mint.liquidity
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1])
      // update the transaction

      mints.pop()
    }
    burn.save()
    // if accessing last one, replace it
    if (burn.needsComplete) {
      burns[burns.length - 1] = burn.id
    }
    // else add new one
    else {
      burns.push(burn.id)
    }
  }

  transaction.save()
  pair.save()
}

export function handleSync(event: Sync): void {
  const pairId = event.address.toHex();
  const pair = Pair.load(pairId)!
  const token0 = Token.load(pair.token0)!
  const token1 = Token.load(pair.token1)!
  const uniswap = UniswapFactory.load(FACTORY_ADDRESS_STRING)!
  const bundle = Bundle.load('1')!

  // reset factory liquidity by subtracting only tracked liquidity
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.minus(pair.trackedReserveETH as BigDecimal)

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
  token0.derivedETH = token0ETH
  const token1ETH = findEthPerToken(token1 as Token)
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

  // use tracked amounts globally
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.plus(trackedLiquidityETH)
  uniswap.totalLiquidityUSD = uniswap.totalLiquidityETH.times(ethPrice)

  // save entities
  pair.save()
  uniswap.save()
  token0.save()
  token1.save()
  bundle.save()
}

export function handleMint(event: Mint): void {
  log.info("Try to get 0", [])
  const sender = event.parameters[0].value.toAddress()
  log.info("Try to get 1", [])
  const amount0 = event.parameters[1].value.toBigInt()
  log.info("Try to get 2", [])
  const amount1 = event.parameters[2].value.toBigInt()
  log.info("Finished", [])
  const transaction = Transaction.load(event.transaction.hash.toHexString())!
  log.info("transaction", [])
  const mints = transaction.mints
  log.info("mints", [])
  const mint = MintEvent.load(mints[mints.length - 1])!
  log.info("mint", [])
  const pairId = event.address.toHex()
  log.info("pairId", [])
  const pair = Pair.load(pairId)!
  const uniswap = UniswapFactory.load(FACTORY_ADDRESS_STRING)!
  const token0 = Token.load(pair.token0)!
  const token1 = Token.load(pair.token1)!
  const bundle = Bundle.load('1')!
  const ethPrice = bundle.ethPrice

  log.info("Hello", [])
  // update exchange info (except balances, sync will cover that)
  const token0Amount = convertTokenToDecimal(amount0, token0.decimals.toI32())
  const token1Amount = convertTokenToDecimal(amount1, token1.decimals.toI32())

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // update txn counts
  pair.txCount = pair.txCount.plus(ONE_BI)
  uniswap.txCount = uniswap.txCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(ethPrice)
  log.info("Bye", [])

  mint.sender = sender
  mint.amount0 = token0Amount as BigDecimal
  mint.amount1 = token1Amount as BigDecimal
  mint.logIndex = event.logIndex
  mint.amountUSD = amountTotalUSD as BigDecimal

  const timestamp = event.block.timestamp.toI32()
  // update day entities
  const pairDayData = updatePairDayData(pairId, pair as Pair, event.address, timestamp)
  const pairHourData = updatePairHourData(pairId, pair as Pair, timestamp)
  const uniswapDayData = updateUniswapDayData(uniswap, timestamp)
  const token0DayData = updateTokenDayData(token0, ethPrice, timestamp)
  const token1DayData = updateTokenDayData(token1, ethPrice, timestamp)
  log.info("Bomb", [])

  // save entities
  mint.save()
  token0.save()
  token1.save()
  pair.save()
  uniswap.save()
  uniswapDayData.save()
  pairHourData.save()
  pairDayData.save()
  token0DayData.save()
  token1DayData.save()
  log.info("Save", [])
}

export function handleBurn(event: Burn): void {
  const transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  const burns = transaction.burns
  const burn = BurnEvent.load(burns[burns.length - 1])!
  const pairId = event.address.toHex()
  const pair = Pair.load(pairId)!
  const uniswap = UniswapFactory.load(FACTORY_ADDRESS_STRING)!
  const bundle = Bundle.load('1')!
  const ethPrice = bundle.ethPrice

  //update token info
  const token0 = Token.load(pair.token0)!
  const token1 = Token.load(pair.token1)!
  const token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals.toI32())
  const token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals.toI32())

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // update txn counts
  uniswap.txCount = uniswap.txCount.plus(ONE_BI)
  pair.txCount = pair.txCount.plus(ONE_BI)

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

  // update day entities
  const timestamp = event.block.timestamp.toI32()
  const pairDayData = updatePairDayData(pairId, pair as Pair, event.address, timestamp)
  const pairHourData = updatePairHourData(pairId, pair as Pair, timestamp)
  const uniswapDayData = updateUniswapDayData(uniswap, timestamp)
  const token0DayData = updateTokenDayData(token0, ethPrice, timestamp)
  const token1DayData = updateTokenDayData(token1, ethPrice, timestamp)

  // update global counter and save
  token0.save()
  token1.save()
  pair.save()
  uniswap.save()
  burn.save()
  uniswapDayData.save()
  pairHourData.save()
  pairDayData.save()
  token0DayData.save()
  token1DayData.save()
}

export function handleSwap(event: Swap): void {
  const uniswap = UniswapFactory.load(FACTORY_ADDRESS_STRING)!
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

  // get total amounts of derived USD and ETH for tracking
  const derivedAmountETH = token1ETH
    .times(amount1Total)
    .plus(token0ETH.times(amount0Total))
    .div(BigDecimal.fromString('2'))
  const derivedAmountUSD = derivedAmountETH.times(ethPrice)

  // only accounts for volume through white listed tokens
  const trackedAmountUSD = getTrackedVolumeUSD(ethPrice, token0.id, amount0Total, token0ETH, token1.id, amount1Total, token1ETH)

  let trackedAmountETH: BigDecimal
  if (ethPrice.equals(ZERO_BD)) {
    trackedAmountETH = ZERO_BD
  } else {
    trackedAmountETH = trackedAmountUSD.div(ethPrice)
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
  pair.txCount = pair.txCount.plus(ONE_BI)

  // update global values, only used tracked amounts for volume
  uniswap.totalVolumeUSD = uniswap.totalVolumeUSD.plus(trackedAmountUSD)
  uniswap.totalVolumeETH = uniswap.totalVolumeETH.plus(trackedAmountETH)
  uniswap.untrackedVolumeUSD = uniswap.untrackedVolumeUSD.plus(derivedAmountUSD)
  uniswap.txCount = uniswap.txCount.plus(ONE_BI)

  const transactionHashId = event.transaction.hash.toHexString()
  let transaction = Transaction.load(transactionHashId)
  if (transaction === null) {
    transaction = new Transaction(transactionHashId)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
  }
  const swaps = transaction.swaps
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
  swaps.push(swap.id)

  // update day entities
  const timestamp = event.block.timestamp.toI32()
  const pairDayData = updatePairDayData(pairId, pair as Pair, event.address, timestamp)
  const pairHourData = updatePairHourData(pairId, pair as Pair, timestamp)
  const uniswapDayData = updateUniswapDayData(uniswap, timestamp)
  const token0DayData = updateTokenDayData(token0, ethPrice, timestamp)
  const token1DayData = updateTokenDayData(token1, ethPrice, timestamp)

  // swap specific updating
  uniswapDayData.dailyVolumeUSD = uniswapDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  uniswapDayData.dailyVolumeETH = uniswapDayData.dailyVolumeETH.plus(trackedAmountETH)
  uniswapDayData.dailyVolumeUntracked = uniswapDayData.dailyVolumeUntracked.plus(derivedAmountUSD)

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total)
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total)
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD)

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total)
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total)
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total)
  const daily0VolumeETH = amount0Total.times(token0ETH)
  token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(daily0VolumeETH)
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(daily0VolumeETH.times(ethPrice))

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total)
  const daily1VolumeETH = amount1Total.times(token1ETH)
  token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(daily1VolumeETH)
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(daily1VolumeETH.times(ethPrice))

  // save entities
  pair.save()
  token0.save()
  token1.save()
  uniswap.save()
  pair.save()
  swap.save()
  transaction.save()
  pairDayData.save()
  uniswapDayData.save()
  pairHourData.save()
  token0DayData.save()
  token1DayData.save()
}
