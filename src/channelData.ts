import type { PlanContext } from './channels';

// Hand curated, NOT from Overture: who sells each ad channel, roughly what it costs, and where to ask.
// Every entry carries its sources. Prices move, so the UI labels them as indicative and dated.
export const CHANNELS_AS_OF = 'November 2026';

export interface Channel {
  id: string;
  name: string;
  kind: 'digital' | 'mail' | 'transit' | 'outdoor';
  regions: string[]; // '*' worldwide, an ISO country code, or a city slug
  seller: string;
  contactUrl: string;
  contactDetail?: string;
  cost: string;
  costBasis: 'published rate' | 'third party estimate' | 'no public rate';
  targeting: string;
  forPlan?: (ctx: PlanContext) => string | null; // one line computed from the plan on screen
  sources: { label: string; url: string }[];
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const money = (x: number) => `$${n(x)}`;
const zones = (ctx: PlanContext) =>
  `${ctx.zoneIds.length} ${ctx.city.meta.zoneKind === 'zip' ? (ctx.city.meta.country === 'US' ? 'ZIP code' : 'postal code') : 'area'}${ctx.zoneIds.length === 1 ? '' : 's'}`;
const stops = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? '' : 's'}`;

// Shared "what is in your plan" lines for transit sellers.
const railLine = (ctx: PlanContext) =>
  ctx.transit.rail
    ? `${stops(ctx.transit.rail, 'rail stop')} on record inside your ${zones(ctx)}. Ask for stations that serve them.`
    : ctx.zoneIds.length
      ? `No rail stops on record inside your ${zones(ctx)}, so station ads would reach commuters from elsewhere.`
      : null;
const busLine = (ctx: PlanContext) =>
  ctx.transit.bus ? `${stops(ctx.transit.bus, 'bus stop')} on record inside your ${zones(ctx)}. Ask for routes and shelters that serve them.` : null;

// For sellers tied to one operator, only claim stations whose Overture name says so.
// Overture does not record which agency runs a stop, so silence beats a wrong match.
const operatorLine = (pattern: RegExp, label: string) => (ctx: PlanContext) => {
  const hits = ctx.transit.railNames.filter((name) => pattern.test(name));
  return hits.length ? `${label} on record inside your ${zones(ctx)}: ${hits.slice(0, 3).join(', ')}.` : null;
};
const muniLine = (ctx: PlanContext) => {
  const parts = [ctx.transit.rail ? stops(ctx.transit.rail, 'rail stop') : '', ctx.transit.bus ? stops(ctx.transit.bus, 'bus stop') : ''].filter(Boolean);
  if (!parts.length) return null;
  // Counts only: Overture's station names are too noisy to print as a shortlist.
  return `${parts.join(' and ')} on record inside your ${zones(ctx)}. Ask for the lines that serve them.`;
};

const ADQUICK_TRANSIT = {
  label: 'AdQuick transit cost guide',
  url: 'https://www.adquick.com/answers/transit-advertising/how-much-does-it-cost-to-advertise-on-local-transit',
};
const SFMTA = { label: 'SFMTA: Advertise on Muni', url: 'https://www.sfmta.com/getting-around/muni/advertise-muni' };

// Google search benchmarks by business type (WordStream, US, data to March 2026).
const GOOGLE_CPC: { when: RegExp; label: string; cpc: number }[] = [
  { when: /dental|dentist|orthodon/, label: 'dentists', cpc: 8.0 },
  { when: /restaurant|eatery|cafe|coffee|bakery|bar$|pizz/, label: 'restaurants', cpc: 2.05 },
  { when: /gym|fitness|yoga|pilates/, label: 'health and fitness', cpc: 6.17 },
];

export const CHANNELS: Channel[] = [
  /* ---------- San Francisco ---------- */
  {
    id: 'sf-muni-vehicles',
    name: 'Muni buses and trains',
    kind: 'transit',
    regions: ['san-francisco'],
    seller: 'Intersection',
    contactUrl: SFMTA.url,
    contactDetail: 'SFMTA lists the current sales contact',
    cost: 'About $500 to $3,000 per bus side per 4 weeks (US wide range, no Muni rate card is public)',
    costBasis: 'third party estimate',
    targeting: 'Bought by route, line and vehicle type. There is no ZIP targeting, so pick routes that cross your zones.',
    forPlan: muniLine,
    sources: [SFMTA, { label: 'Intersection San Francisco', url: 'https://www.intersection.com/market/san-francisco/' }, ADQUICK_TRANSIT],
  },
  {
    id: 'sf-muni-shelters',
    name: 'Muni shelters and Market Street stations',
    kind: 'transit',
    regions: ['san-francisco'],
    seller: 'Clear Channel Outdoor',
    contactUrl: 'https://clearchanneloutdoor.com/where-we-are/san-francisco',
    cost: 'About $500 to $3,500 per shelter per month (US wide range)',
    costBasis: 'third party estimate',
    targeting: 'Pick individual shelters or clusters by street, neighborhood or route. The closest outdoor match to a ZIP plan.',
    forPlan: busLine,
    sources: [SFMTA, { label: 'Clear Channel Outdoor San Francisco', url: 'https://clearchanneloutdoor.com/where-we-are/san-francisco' }, ADQUICK_TRANSIT],
  },
  {
    id: 'sf-bart',
    name: 'BART stations and trains',
    kind: 'transit',
    regions: ['san-francisco'],
    seller: 'OUTFRONT Media',
    contactUrl: 'https://www.outfront.com/media/transit-advertising/bart-advertising',
    cost: 'No public BART rates. Transit posters generally run $500 to $6,000 or more per placement per month; train interior cards $75 to $500',
    costBasis: 'third party estimate',
    targeting: 'Bought by station or line. Station posters near the business are the usual small budget entry.',
    forPlan: operatorLine(/\bBART\b/i, 'BART'),
    sources: [{ label: 'BART advertising', url: 'https://www.bart.gov/node/11657' }, { label: 'OUTFRONT BART', url: 'https://www.outfront.com/media/transit-advertising/bart-advertising' }, ADQUICK_TRANSIT],
  },
  {
    id: 'sf-caltrain',
    name: 'Caltrain stations, trains and digital displays',
    kind: 'transit',
    regions: ['san-francisco'],
    seller: 'OUTFRONT Media',
    contactUrl: 'https://www.caltrain.com/about-caltrain/doing-business/advertising/station-ads-digital-displays',
    contactDetail: 'Caltrain lists the current sales contact',
    cost: 'Quoted by station package',
    costBasis: 'no public rate',
    targeting: 'Bought by station or as a station takeover along the San Francisco to San Jose corridor. Best for reaching Peninsula commuters, not one neighborhood.',
    forPlan: operatorLine(/caltrain/i, 'Caltrain'),
    sources: [{ label: 'Caltrain advertising', url: 'https://www.caltrain.com/about-caltrain/doing-business/advertising/station-ads-digital-displays' }],
  },
  {
    id: 'sf-billboards-cco',
    name: 'Billboards: bulletins, digital and wallscapes',
    kind: 'outdoor',
    regions: ['san-francisco'],
    seller: 'Clear Channel Outdoor',
    contactUrl: 'https://clearchanneloutdoor.com/contact-us',
    cost: 'Static bulletin about $4,000 to $15,000 per 4 weeks, premium faces $20,000 and up; digital $3,500 to $25,000 per 4 weeks',
    costBasis: 'third party estimate',
    targeting: 'Pick individual faces by street or corridor. A billboard reaches whoever drives past, so match the corridor to your zones.',
    sources: [{ label: 'AdQuick San Francisco billboard costs', url: 'https://www.adquick.com/billboard-cost/san-francisco-ca' }, { label: 'Clear Channel Outdoor San Francisco', url: 'https://clearchanneloutdoor.com/where-we-are/san-francisco' }],
  },
  {
    id: 'sf-billboards-outfront',
    name: 'Freeway digital bulletins (US 101, I 280, I 80)',
    kind: 'outdoor',
    regions: ['san-francisco'],
    seller: 'OUTFRONT Media',
    contactUrl: 'https://www.outfront.com/markets/san-francisco',
    cost: 'About $4,000 to $16,000 per digital unit per month',
    costBasis: 'third party estimate',
    targeting: 'Bought by corridor as a share of the screen rotation. Regional reach, not neighborhood reach.',
    sources: [{ label: 'AdQuick San Francisco digital outdoor', url: 'https://www.adquick.com/dooh-advertising/san-francisco-ca' }, { label: 'OUTFRONT San Francisco', url: 'https://www.outfront.com/markets/san-francisco' }],
  },
  {
    id: 'sf-blip',
    name: 'Self serve digital billboards',
    kind: 'outdoor',
    regions: ['san-francisco'],
    seller: 'Blip',
    contactUrl: 'https://blipbillboards.com/billboard-locations/california/san-francisco',
    cost: 'Pay per ad play with no minimum spend; sample budgets on the site run $20 to $100 a day',
    costBasis: 'published rate',
    targeting: 'Pick digital boards on a map and set a daily budget. The low risk way to test outdoor.',
    sources: [{ label: 'Blip San Francisco', url: 'https://blipbillboards.com/billboard-locations/california/san-francisco' }],
  },
  {
    id: 'sf-adquick',
    name: 'Outdoor marketplace: billboards, transit, digital',
    kind: 'outdoor',
    regions: ['san-francisco'],
    seller: 'AdQuick',
    contactUrl: 'https://www.adquick.com/billboard-cost/san-francisco-ca',
    cost: 'San Francisco boards from about $3,500 digital and $4,000 static per 4 weeks; programmatic digital from $1,500',
    costBasis: 'third party estimate',
    targeting: 'Browse inventory from several owners on one map and book by geography.',
    sources: [{ label: 'AdQuick San Francisco billboard costs', url: 'https://www.adquick.com/billboard-cost/san-francisco-ca' }],
  },

  /* ---------- other cities: seller and where to ask, no prices ---------- */
  {
    id: 'ny-mta',
    name: 'MTA subway, buses and stations',
    kind: 'transit',
    regions: ['new-york'],
    seller: 'OUTFRONT Media',
    contactUrl: 'https://www.mta.info/doing-business-with-us/advertising',
    contactDetail: 'MTA lists the current sales contact',
    cost: 'Quoted by campaign',
    costBasis: 'no public rate',
    targeting: 'Bought by station, line or bus depot.',
    forPlan: railLine,
    sources: [{ label: 'MTA advertising', url: 'https://www.mta.info/doing-business-with-us/advertising' }],
  },
  {
    id: 'la-metro',
    name: 'LA Metro buses and rail',
    kind: 'transit',
    regions: ['los-angeles'],
    seller: 'OUTFRONT (bus) and Intersection (rail)',
    contactUrl: 'https://www.metro.net/about/advertising/',
    contactDetail: 'Metro lists both sales contacts',
    cost: 'Quoted by campaign',
    costBasis: 'no public rate',
    targeting: 'Bought by bus division, line or station.',
    forPlan: railLine,
    sources: [{ label: 'LA Metro advertising', url: 'https://www.metro.net/about/advertising/' }],
  },
  {
    id: 'chicago-cta',
    name: 'CTA buses and trains',
    kind: 'transit',
    regions: ['chicago'],
    seller: 'Intersection',
    contactUrl: 'https://www.intersection.com/market/chicago/',
    cost: 'Quoted by campaign',
    costBasis: 'no public rate',
    targeting: 'Bought by line, station or bus garage.',
    forPlan: railLine,
    sources: [{ label: 'CTA advertising', url: 'https://transitchicago.com/advertising/' }, { label: 'Intersection Chicago', url: 'https://www.intersection.com/market/chicago/' }],
  },
  {
    id: 'london-tfl',
    name: 'TfL Underground, buses and shelters',
    kind: 'transit',
    regions: ['london'],
    seller: 'Global (Tube and buses) and JCDecaux (shelters)',
    contactUrl: 'https://tfl.gov.uk/info-for/business-and-advertisers/advertising',
    cost: 'Quoted by campaign',
    costBasis: 'no public rate',
    targeting: 'Bought by station, line or bus route.',
    forPlan: railLine,
    sources: [{ label: 'TfL advertising', url: 'https://tfl.gov.uk/info-for/business-and-advertisers/advertising' }],
  },

  /* ---------- United States ---------- */
  {
    id: 'us-eddm',
    name: 'Every Door Direct Mail',
    kind: 'mail',
    regions: ['US'],
    seller: 'USPS',
    contactUrl: 'https://eddm.usps.com/eddm',
    cost: '$0.26 postage per piece, plus printing',
    costBasis: 'published rate',
    targeting: 'Pick carrier routes inside a ZIP in the USPS tool. 200 to 5,000 pieces per ZIP per day. The channel that maps most directly onto a ZIP plan.',
    forPlan: (ctx) =>
      ctx.reach && ctx.city.meta.zoneKind === 'zip' && ctx.city.meta.reachSource === 'addresses'
        ? `About ${money(ctx.reach * 0.26)} postage to mail all ${n(ctx.reach)} addresses in your ${zones(ctx)}. USPS route counts will differ from Overture's, so treat this as a first estimate.`
        : null,
    sources: [{ label: 'USPS Every Door Direct Mail', url: 'https://www.usps.com/business/every-door-direct-mail.htm' }],
  },
  {
    id: 'us-nextdoor',
    name: 'Nextdoor neighborhood ads',
    kind: 'digital',
    regions: ['US'],
    seller: 'Nextdoor',
    contactUrl: 'https://business.nextdoor.com/en-us/local/advertise-with-nextdoor-broad',
    cost: 'No minimum listed; Nextdoor says small businesses often spend under $5 a day',
    costBasis: 'published rate',
    targeting: 'Aimed at verified neighborhoods or a service area. Self serve.',
    sources: [{ label: 'Nextdoor for business', url: 'https://business.nextdoor.com/en-us/local/advertise-with-nextdoor-broad' }],
  },

  /* ---------- anywhere ---------- */
  {
    id: 'meta',
    name: 'Facebook and Instagram ads',
    kind: 'digital',
    regions: ['*'],
    seller: 'Meta',
    contactUrl: 'https://www.facebook.com/business/ads',
    cost: 'US benchmark: about $0.60 a click for traffic campaigns, $1.80 for lead campaigns',
    costBasis: 'third party estimate',
    targeting: 'Accepts postal codes in bulk, or a pin with a radius from about 1 km to 80 km. Self serve.',
    forPlan: (ctx) =>
      ctx.zoneIds.length
        ? ctx.city.meta.zoneKind === 'zip'
          ? `Paste your ${zones(ctx)} straight into location targeting with the Copy button below.`
          : `Enter your ${zones(ctx)} as pin drops with the Copy button below.`
        : null,
    sources: [
      { label: 'WordStream Facebook benchmarks 2026', url: 'https://www.wordstream.com/wp-content/uploads/2026/09/ws-guide-facebook-ads-benchmarks-2026.pdf' },
      { label: 'Meta targeting reference', url: 'https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting' },
    ],
  },
  {
    id: 'google',
    name: 'Google Ads local search',
    kind: 'digital',
    regions: ['*'],
    seller: 'Google',
    contactUrl: 'https://ads.google.com/',
    cost: 'US benchmark: about $5.42 a click on average across industries',
    costBasis: 'third party estimate',
    targeting: 'Accepts postal codes (availability varies by country) or a radius of 1 km and up. You pay when someone searching nearby clicks.',
    forPlan: (ctx) => {
      const hit = GOOGLE_CPC.find((g) => g.when.test(ctx.catId));
      return hit ? `US benchmark for ${hit.label}: about $${hit.cpc.toFixed(2)} a click.` : null;
    },
    sources: [
      { label: 'WordStream Google Ads benchmarks 2026', url: 'https://wordstream.com/blog/2026-google-ads-benchmarks' },
      { label: 'Google Ads location targeting', url: 'https://support.google.com/google-ads/answer/1722043?hl=en' },
    ],
  },
];
