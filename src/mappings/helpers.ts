/* eslint-disable prefer-const */
import { BigInt, BigDecimal, Address } from '@graphprotocol/graph-ts'
import { ERC20 } from '../types/Factory/ERC20'
import { ERC20SymbolBytes } from '../types/Factory/ERC20SymbolBytes'
import { ERC20NameBytes } from '../types/Factory/ERC20NameBytes'
import { Bundle, Pair, Token, User, LiquidityPosition } from '../types/schema'

export const ZERO_ADDRESS = Address.fromString('0x0000000000000000000000000000000000000000')

export let ONE_BI = BigInt.fromI32(1)
export let ZERO_BD = BigDecimal.fromString('0')
export let TEN_BD = BigDecimal.fromString('10')
export let TEN_6_BD = BigDecimal.fromString('1000000')
export let TEN_9_BD = BigDecimal.fromString('1000000000')
export let TEN_18_BD = BigDecimal.fromString('1000000000000000000')

export function exponentToBigDecimal(decimals: i32): BigDecimal {
  if (decimals == 18) {
    return TEN_18_BD;
  } else if (decimals == 9) {
    return TEN_9_BD;
  } else if (decimals == 6) {
    return TEN_6_BD;
  }
  let result = BigDecimal.fromString('1')
  for (let i = 0; i < decimals; ++i) {
    result = result.times(TEN_BD)
  }
  return result
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: i32): BigDecimal {
  if (exchangeDecimals == 0) {
    return tokenAmount.toBigDecimal()
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
}

export function isNullEthValue(value: string): boolean {
  return value == '0x0000000000000000000000000000000000000000000000000000000000000001'
}

export function fetchToken(id: string, address: Address): Token | null {
  const result = new Token(id)
  const contract = ERC20.bind(address)
  const contractNameBytes = ERC20NameBytes.bind(address)
  const contractSymbolBytes = ERC20SymbolBytes.bind(address)

  // try types uint8 for decimals
  let decimalValue = null
  let decimalResult = contract.try_decimals()
  if (!decimalResult.reverted) {
    decimalValue = decimalResult.value
  }
  if (decimalValue == null) {
    return null
  }
  result.decimals = BigInt.fromI32(decimalValue as i32);

  // try types string and bytes32 for symbol
  let symbolValue = 'unknown'
  let symbolResult = contract.try_symbol()
  if (symbolResult.reverted) {
    let symbolResultBytes = contractSymbolBytes.try_symbol()
    if (!symbolResultBytes.reverted) {
      // for broken pairs that have no symbol function exposed
      if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
        symbolValue = symbolResultBytes.value.toString()
      }
    }
  } else {
    symbolValue = symbolResult.value
  }
  result.symbol = symbolValue;

  // try types string and bytes32 for name
  let nameValue = 'unknown'
  let nameResult = contract.try_name()
  if (nameResult.reverted) {
    let nameResultBytes = contractNameBytes.try_name()
    if (!nameResultBytes.reverted) {
      // for broken exchanges that have no name function exposed
      if (!isNullEthValue(nameResultBytes.value.toHexString())) {
        nameValue = nameResultBytes.value.toString()
      }
    }
  } else {
    nameValue = nameResult.value
  }
  result.name = nameValue;

  return result;
}

export function getUser(address: Address): User | null {
  let userId = address.toHexString();
  if (address.equals(ZERO_ADDRESS) || Pair.load(userId) != null)
    return null;

  let user = User.load(userId)
  if (user === null) {
    user = new User(userId)
    user.balance = ZERO_BD
    user.usdSwapped = ZERO_BD
    user.feesUsdPaid = ZERO_BD
    user.lpTransfers = []
    user.liquidityPositions = []
    user.transactions = []
  }

  return user;
}

export function createLiquiditySnapshot(pair: Pair, timestamp: BigInt, blockNumber: BigInt): LiquidityPosition {
  let bundle = Bundle.load('1')
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)

  // create new snapshot
  let snapshot = new LiquidityPosition("")
  snapshot.timestamp = timestamp
  snapshot.blockNumber = blockNumber
  snapshot.token0PriceUSD = token0.derivedETH.times(bundle.ethPrice)
  snapshot.token1PriceUSD = token1.derivedETH.times(bundle.ethPrice)
  snapshot.reserve0 = pair.reserve0
  snapshot.reserve1 = pair.reserve1
  snapshot.reserveUSD = pair.reserveUSD
  snapshot.liquidityTokenTotalSupply = pair.totalSupply
  return snapshot
}
