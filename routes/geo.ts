/**
 * Nominatim proxy for event location search/reverse. Browser never calls OSM directly.
 * Layer: route. requireAuth. See `.cursor/rules/events.mdc`.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const USER_AGENT = 'PeerPool/1.0 (https://peerpool.at; support@peerpool.at)'

let lastNominatimAt = 0

type NominatimAddress = Record<string, string>

function pickFirst(address: NominatimAddress, keys: string[]): string {
  for (const k of keys) {
    const v = address[k]?.trim()
    if (v) return v
  }
  return ''
}

/** Street/plaza name + house number → "Hauptplatz 30". Never number-only. */
function streetLineFromAddress(address: NominatimAddress): string {
  const road = pickFirst(address, [
    'road',
    'pedestrian',
    'footway',
    'path',
    'square',
    'neighbourhood',
  ])
  const number = pickFirst(address, ['house_number', 'house_name'])
  if (road && number) return `${road} ${number}`
  if (road) return road
  return ''
}

function cityFromAddress(address: NominatimAddress): string {
  return pickFirst(address, ['city', 'town', 'village', 'municipality'])
}

function joinParts(parts: string[]): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of parts) {
    const t = p.trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out.join(', ')
}

/**
 * Short: "[street number], [postcode], [city]" e.g. "Hauptplatz 30, 4020, Linz"
 */
function shortLabelFromAddress(address: NominatimAddress | undefined): string | null {
  if (!address) return null
  const street = streetLineFromAddress(address)
  const postcode = pickFirst(address, ['postcode'])
  const city = cityFromAddress(address)
  const label = joinParts([street, postcode, city])
  return label || null
}

/**
 * Full ordered label from address parts (prefer over raw display_name).
 * e.g. "Hauptplatz 30, 4020, Linz, Innere Stadt, Altstadtviertel, Oberösterreich, Österreich"
 */
function fullLabelFromAddress(
  address: NominatimAddress | undefined,
  displayNameFallback: string,
): string {
  if (!address) return displayNameFallback
  const street = streetLineFromAddress(address)
  const postcode = pickFirst(address, ['postcode'])
  const city = cityFromAddress(address)
  const district = pickFirst(address, ['suburb', 'city_district', 'quarter'])
  const neighbourhood = pickFirst(address, ['neighbourhood'])
  const county = pickFirst(address, ['county', 'state_district'])
  const state = pickFirst(address, ['state'])
  const country = pickFirst(address, ['country'])
  // neighbourhood already used in street line when no road — skip duplicate
  const roadUsed = Boolean(
    pickFirst(address, ['road', 'pedestrian', 'footway', 'path', 'square']),
  )
  const neighPart = roadUsed ? neighbourhood : ''
  const label = joinParts([street, postcode, city, district, neighPart, county, state, country])
  return label || displayNameFallback
}

function capLabel(s: string): string {
  return s.slice(0, TEXT_LIMITS.locationText)
}

function labelsFromNominatim(
  address: NominatimAddress | undefined,
  displayName: string,
): { shortLabel: string; fullLabel: string } {
  const fullLabel = capLabel(fullLabelFromAddress(address, displayName))
  const shortLabel = capLabel(shortLabelFromAddress(address) ?? fullLabel)
  return { shortLabel, fullLabel }
}

async function nominatimGet(path: string): Promise<unknown> {
  const wait = 1100 - (Date.now() - lastNominatimAt)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastNominatimAt = Date.now()

  const res = await fetch(`${NOMINATIM}${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Geocode failed (${res.status})`)
  }
  return res.json()
}

export async function geoRoutes(app: FastifyInstance) {
  /**
   * GET `/geo/search?q=` — forward geocode (max 5).
   */
  app.get<{ Querystring: { q?: string } }>(
    '/geo/search',
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = (request.query.q ?? '').trim()
      if (q.length < 2) {
        return reply.code(400).send({ error: 'Query must be at least 2 characters' })
      }
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }
      try {
        const data = (await nominatimGet(
          `/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`,
        )) as Array<{
          lat: string
          lon: string
          display_name: string
          address?: NominatimAddress
        }>
        return {
          results: (data ?? []).map((r) => {
            const display = r.display_name
            const { shortLabel, fullLabel } = labelsFromNominatim(r.address, display)
            return {
              lat: Number(r.lat),
              lng: Number(r.lon),
              label: fullLabel,
              fullLabel,
              shortLabel,
            }
          }),
        }
      } catch (e) {
        request.log.error(e)
        return reply.code(502).send({ error: 'Geocode search failed' })
      }
    },
  )

  /**
   * GET `/geo/reverse?lat=&lng=` — reverse geocode one point.
   */
  app.get<{ Querystring: { lat?: string; lng?: string } }>(
    '/geo/reverse',
    { preHandler: requireAuth },
    async (request, reply) => {
      const lat = Number(request.query.lat)
      const lng = Number(request.query.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return reply.code(400).send({ error: 'lat and lng required' })
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply.code(400).send({ error: 'Invalid coordinates' })
      }
      try {
        const data = (await nominatimGet(
          `/reverse?format=jsonv2&addressdetails=1&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}`,
        )) as { display_name?: string; address?: NominatimAddress }
        const display = data.display_name ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
        const { shortLabel, fullLabel } = labelsFromNominatim(data.address, display)
        return {
          lat,
          lng,
          label: fullLabel,
          fullLabel,
          shortLabel,
        }
      } catch (e) {
        request.log.error(e)
        return reply.code(502).send({ error: 'Reverse geocode failed' })
      }
    },
  )
}
