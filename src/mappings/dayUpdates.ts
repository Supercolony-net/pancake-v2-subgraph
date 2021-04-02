/* eslint-disable prefer-const */
import { PairHourData } from './../types/schema'
import { BigInt, BigDecimal, Address } from '@graphprotocol/graph-ts'
import { Pair, Token, UniswapFactory, UniswapDayData, PairDayData, TokenDayData } from '../types/schema'
import { ONE_BI, ZERO_BD, ZERO_BI } from './helpers'

export function updateUniswapDayData(uniswap: UniswapFactory, timestamp: i32): UniswapDayData {
  const dayID = timestamp / 86400
  const dayStartTimestamp = dayID * 86400
  let uniswapDayData = UniswapDayData.load(dayID.toString())
  if (uniswapDayData === null) {
    uniswapDayData = new UniswapDayData(dayID.toString())
    uniswapDayData.date = dayStartTimestamp
    uniswapDayData.dailyVolumeUSD = ZERO_BD
    uniswapDayData.dailyVolumeETH = ZERO_BD
    uniswapDayData.totalVolumeUSD = ZERO_BD
    uniswapDayData.totalVolumeETH = ZERO_BD
    uniswapDayData.dailyVolumeUntracked = ZERO_BD
  }

  uniswapDayData.totalLiquidityUSD = uniswap.totalLiquidityUSD
  uniswapDayData.totalLiquidityETH = uniswap.totalLiquidityETH
  uniswapDayData.txCount = uniswap.txCount

  return uniswapDayData as UniswapDayData
}

export function updatePairDayData(pairId: string, pair: Pair, pairAddress: Address, timestamp: i32): PairDayData {
  const dayID = timestamp / 86400
  const dayStartTimestamp = dayID * 86400
  const dayPairID = pairId
    .concat('-')
    .concat(dayID.toString())
  let pairDayData = PairDayData.load(dayPairID)
  if (pairDayData === null) {
    pairDayData = new PairDayData(dayPairID)
    pairDayData.date = dayStartTimestamp
    pairDayData.token0 = pair.token0
    pairDayData.token1 = pair.token1
    pairDayData.pairAddress = pairAddress
    pairDayData.dailyVolumeToken0 = ZERO_BD
    pairDayData.dailyVolumeToken1 = ZERO_BD
    pairDayData.dailyVolumeUSD = ZERO_BD
    pairDayData.dailyTxns = ZERO_BI
  }

  pairDayData.totalSupply = pair.totalSupply
  pairDayData.reserve0 = pair.reserve0
  pairDayData.reserve1 = pair.reserve1
  pairDayData.reserveUSD = pair.reserveUSD
  pairDayData.dailyTxns = pairDayData.dailyTxns.plus(ONE_BI)

  return pairDayData as PairDayData
}

export function updatePairHourData(pairId: string, pair: Pair, timestamp: i32): PairHourData {
  const hourIndex = timestamp / 3600 // get unique hour within unix history
  const hourStartUnix = hourIndex * 3600 // want the rounded effect
  const hourPairID = pairId
    .concat('-')
    .concat(BigInt.fromI32(hourIndex).toString())
  let pairHourData = PairHourData.load(hourPairID)
  if (pairHourData === null) {
    pairHourData = new PairHourData(hourPairID)
    pairHourData.hourStartUnix = hourStartUnix
    pairHourData.pair = pairId
    pairHourData.hourlyVolumeToken0 = ZERO_BD
    pairHourData.hourlyVolumeToken1 = ZERO_BD
    pairHourData.hourlyVolumeUSD = ZERO_BD
    pairHourData.hourlyTxns = ZERO_BI
  }

  pairHourData.reserve0 = pair.reserve0
  pairHourData.reserve1 = pair.reserve1
  pairHourData.reserveUSD = pair.reserveUSD
  pairHourData.hourlyTxns = pairHourData.hourlyTxns.plus(ONE_BI)

  return pairHourData as PairHourData
}

export function updateTokenDayData(token: Token, ethPrice: BigDecimal, timestamp: i32): TokenDayData {
  const dayID = timestamp / 86400
  const dayStartTimestamp = dayID * 86400
  const tokenId = token.id
  const tokenDayID = tokenId
    .toString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())
  const derived = token.derivedETH;

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    tokenDayData.date = dayStartTimestamp
    tokenDayData.token = tokenId
    tokenDayData.dailyVolumeToken = ZERO_BD
    tokenDayData.dailyVolumeETH = ZERO_BD
    tokenDayData.dailyVolumeUSD = ZERO_BD
    tokenDayData.dailyTxns = ZERO_BI
    tokenDayData.totalLiquidityUSD = ZERO_BD
  }
  tokenDayData.priceUSD = derived.times(ethPrice)
  const totalLiquidity = token.totalLiquidity;
  const totalLiquidityETH = token.totalLiquidity.times(derived)
  tokenDayData.totalLiquidityToken = totalLiquidity
  tokenDayData.totalLiquidityETH = totalLiquidityETH
  tokenDayData.totalLiquidityUSD = totalLiquidityETH.times(ethPrice)
  tokenDayData.dailyTxns = tokenDayData.dailyTxns.plus(ONE_BI)

  /**
   * @todo test if this speeds up sync
   */
  // updateStoredTokens(tokenDayData as TokenDayData, dayID)
  // updateStoredPairs(tokenDayData as TokenDayData, dayPairID)

  return tokenDayData as TokenDayData
}
