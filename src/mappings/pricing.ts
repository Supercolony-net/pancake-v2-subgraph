/* eslint-disable prefer-const */
import { Pair, Token, Bundle } from '../types/schema'
import { BigDecimal, Address } from '@graphprotocol/graph-ts/index'
import { ZERO_BD, ZERO_ADDRESS, FACTORY_ADDRESS_STRING } from './helpers'
import { Factory as FactoryContract } from '../types/templates/Pair/Factory'

const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
const BUSD_WBNB_PAIR = '0x1b96b92314c44b159149f7e0303511fb2fc4774f' // created block 589414
const USDT_WBNB_PAIR = '0x20bcc3b8a0091ddac2d0bc30f68e6cbb97de59cd' // created block 648115

export function getEthPriceInUSD(pair: Pair): BigDecimal {
  // fetch eth prices for each stablecoin
  let usdtPair: Pair | null;
  if (pair.id == USDT_WBNB_PAIR) {
    usdtPair = pair;
  } else {
    usdtPair = Pair.load(USDT_WBNB_PAIR)
  }

  let busdPair: Pair | null;
  if (pair.id == BUSD_WBNB_PAIR) {
    busdPair = pair;
  } else {
    busdPair = Pair.load(BUSD_WBNB_PAIR)
  }

  // usdt is token0
  // busd is token1
  if (busdPair !== null && usdtPair !== null) {
    const busdtReserve = busdPair.reserve0;
    const usdtReserve = usdtPair.reserve1;
    let totalLiquidityBNB = busdtReserve.plus(usdtReserve)
    let busdWeight = busdtReserve.div(totalLiquidityBNB)
    let usdtWeight = usdtReserve.div(totalLiquidityBNB)
    return busdPair.token1Price.times(busdWeight).plus(usdtPair.token0Price.times(usdtWeight))
    // usdt is the only pair so far
  } else if (busdPair !== null) {
    return busdPair.token1Price
  } else if (usdtPair !== null) {
    return usdtPair.token0Price
  } else {
    return ZERO_BD
  }
}

// token where amounts should contribute to tracked volume and liquidity
let WHITELIST: string[] = [
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0x23396cf899ca06c4472205fc903bdb4de249d6fc', // UST
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', // DAI
  '0x4bd17003473389a42daf6a0a729f6fdb328bbbd7', // VAI
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', // BTCB
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8', // WETH
  '0x250632378e573c6be1ac2f97fcdf00515d0aa91b', // BETH
]

// minimum liquidity for price to get tracked
const MINIMUM_LIQUIDITY_THRESHOLD_ETH = BigDecimal.fromString('2')

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(token: Token): BigDecimal {
  if (token.id == WBNB_ADDRESS) {
    return BigDecimal.fromString('1')
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    // TODO: Remove rpc call by storing pairs
    let factoryContract = FactoryContract.bind(Address.fromString(FACTORY_ADDRESS_STRING))
    let pairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]))
    if (!pairAddress.equals(ZERO_ADDRESS)) {
      let pair = Pair.load(pairAddress.toHexString())!
      if (pair.token0 == token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token1 = Token.load(pair.token1)!
        return pair.token1Price.times(token1.derivedETH as BigDecimal) // return token1 per our token * Eth per token 1
      }
      if (pair.token1 == token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token0 = Token.load(pair.token0)!
        return pair.token0Price.times(token0.derivedETH as BigDecimal) // return token0 per our token * ETH per token 0
      }
    }
  }
  return ZERO_BD // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  ethPrice: BigDecimal,
  token0Id: string,
  tokenAmount0: BigDecimal,
  token0ETH: BigDecimal,
  token1Id: string,
  tokenAmount1: BigDecimal,
  token1ETH: BigDecimal
): BigDecimal {
  let price0 = token0ETH.times(ethPrice)
  let price1 = token1ETH.times(ethPrice)
  const incldue0 = WHITELIST.includes(token0Id);
  const incldue1 = WHITELIST.includes(token1Id);

  // both are whitelist tokens, take average of both amounts
  if (incldue0 && incldue1) {
    return tokenAmount0
      .times(price0)
      .plus(tokenAmount1.times(price1))
      .div(BigDecimal.fromString('2'))
  }

  // take full value of the whitelisted token amount
  if (incldue0 && !incldue1) {
    return tokenAmount0.times(price0)
  }

  // take full value of the whitelisted token amount
  if (!incldue0 && incldue1) {
    return tokenAmount1.times(price1)
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  ethPrice: BigDecimal,
  token0Id: string,
  tokenAmount0: BigDecimal,
  token0ETH: BigDecimal,
  token1Id: string,
  tokenAmount1: BigDecimal,
  token1ETH: BigDecimal
): BigDecimal {
  const price0 = token0ETH.times(ethPrice)
  const price1 = token1ETH.times(ethPrice)

  // both are whitelist tokens, take average of both amounts
  const incldue0 = WHITELIST.includes(token0Id);
  const incldue1 = WHITELIST.includes(token1Id);
  if (incldue0 && incldue1) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1))
  }

  // take double value of the whitelisted token amount
  if (incldue0 && !incldue1) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!incldue0 && incldue1) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}
