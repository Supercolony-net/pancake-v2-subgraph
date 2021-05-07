/* eslint-disable prefer-const */
import { log } from '@graphprotocol/graph-ts'
import { UniswapFactory, Pair, Token, Bundle, GetPair } from '../types/schema'
import { PairCreated } from '../types/Factory/Factory'
import { Pair as PairTemplate } from '../types/templates'
import {
  ZERO_BD,
  ZERO_BI,
  fetchToken, FACTORY_ADDRESS_STRING
} from './helpers'

export function handleNewPair(event: PairCreated): void {
  // load factory (create if first exchange)
  let factory = UniswapFactory.load(FACTORY_ADDRESS_STRING)
  if (factory === null) {
    factory = new UniswapFactory(FACTORY_ADDRESS_STRING)
    factory.pairCount = 0
    factory.totalVolumeETH = ZERO_BD
    factory.totalLiquidityETH = ZERO_BD
    factory.totalVolumeUSD = ZERO_BD
    factory.untrackedVolumeUSD = ZERO_BD
    factory.totalLiquidityUSD = ZERO_BD
    factory.txCount = ZERO_BI

    // create new bundle
    const bundle = new Bundle('1')
    bundle.ethPrice = ZERO_BD
    bundle.save()
  }
  factory.pairCount = factory.pairCount + 1

  const token0Id = event.params.token0.toHexString();
  const token1Id = event.params.token1.toHexString();
  // create the tokens
  let token0 = Token.load(token0Id)
  let token1 = Token.load(token1Id)

  // fetch info if null
  if (token0 === null) {
    token0 = fetchToken(token0Id, event.params.token0)

    // bail if we couldn't figure out the decimals
    if (token0 === null) {
      log.debug('mybug the decimal on token 0 was null', [])
      return
    }

    token0.derivedETH = ZERO_BD
    token0.tradeVolume = ZERO_BD
    token0.tradeVolumeUSD = ZERO_BD
    token0.untrackedVolumeUSD = ZERO_BD
    token0.totalLiquidity = ZERO_BD
    // token0.allPairs = []
    token0.txCount = ZERO_BI
  }

  // fetch info if null
  if (token1 === null) {
    token1 = fetchToken(token1Id, event.params.token1)

    // bail if we couldn't figure out the decimals
    if (token1 === null) {
      return
    }
    token1.derivedETH = ZERO_BD
    token1.tradeVolume = ZERO_BD
    token1.tradeVolumeUSD = ZERO_BD
    token1.untrackedVolumeUSD = ZERO_BD
    token1.totalLiquidity = ZERO_BD
    // token1.allPairs = []
    token1.txCount = ZERO_BI
  }

  const pairId = event.params.pair.toHexString();
  const pair = new Pair(pairId) as Pair
  pair.token0 = token0Id
  pair.token1 = token1Id
  pair.createdAtTimestamp = event.block.timestamp
  pair.createdAtBlockNumber = event.block.number
  pair.txCount = ZERO_BI
  pair.reserve0 = ZERO_BD
  pair.reserve1 = ZERO_BD
  pair.trackedReserveETH = ZERO_BD
  pair.reserveETH = ZERO_BD
  pair.reserveUSD = ZERO_BD
  pair.totalSupply = ZERO_BD
  pair.volumeToken0 = ZERO_BD
  pair.volumeToken1 = ZERO_BD
  pair.volumeUSD = ZERO_BD
  pair.untrackedVolumeUSD = ZERO_BD
  pair.token0Price = ZERO_BD
  pair.token1Price = ZERO_BD

  const token0token1 = new GetPair(token0Id.concat(token1Id))
  token0token1.pair = pairId

  const token1token0 = new GetPair(token1Id.concat(token0Id))
  token1token0.pair = pairId

  // create the tracked contract based on the template
  PairTemplate.create(event.params.pair)

  // save updated values
  token0.save()
  token1.save()
  pair.save()
  factory.save()
  token0token1.save()
  token1token0.save()
}
