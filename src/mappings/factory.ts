/* eslint-disable prefer-const */
import { log } from '@graphprotocol/graph-ts'
import { Pair, Token, Bundle, GetPair } from '../types/schema'
import { PairCreated } from '../types/Factory/Factory'
import { Pair as PairTemplate } from '../types/templates'
import {
  ZERO_BD,
  fetchToken,
} from './helpers'

export function handleNewPair(event: PairCreated): void {
  let bundle = Bundle.load('1')
  if (bundle === null) {
    bundle = new Bundle('1')
    bundle.ethPrice = ZERO_BD
    bundle.save()
  }

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
    token0.totalLiquidity = ZERO_BD
  }

  // fetch info if null
  if (token1 === null) {
    token1 = fetchToken(token1Id, event.params.token1)

    // bail if we couldn't figure out the decimals
    if (token1 === null) {
      return
    }
    token1.derivedETH = ZERO_BD
    token1.totalLiquidity = ZERO_BD
  }

  const pairId = event.params.pair.toHexString();
  const pair = new Pair(pairId) as Pair
  pair.token0 = token0Id
  pair.token1 = token1Id
  pair.createdAtTimestamp = event.block.timestamp
  pair.createdAtBlockNumber = event.block.number
  pair.reserve0 = ZERO_BD
  pair.reserve1 = ZERO_BD
  pair.trackedReserveETH = ZERO_BD
  pair.reserveETH = ZERO_BD
  pair.reserveUSD = ZERO_BD
  pair.totalSupply = ZERO_BD
  pair.token0Price = ZERO_BD
  pair.token1Price = ZERO_BD

  const token0token1 = new GetPair(token0Id.concat(token1Id))
  token0token1.pair = pairId

  const token1token0 = new GetPair(token1Id.concat(token0Id))
  token1token0.pair = pairId

  // create the tracked contract based on the template
  PairTemplate.create(event.params.pair)

  token0.save()
  token1.save()
  pair.save()
  token0token1.save()
  token1token0.save()
}
