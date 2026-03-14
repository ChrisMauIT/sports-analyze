const fetch = require('node-fetch');

const SPORTS_KEY = process.env.SPORTS_KEY || 'e294af2e2e1ffe6ac437596aefa83527';
const ODDS_KEY   = process.env.ODDS_KEY   || 'a0d9d10760d2ce5ce3e1706e22c95916';

// API-Football season label for 2025/2026 = "2025"
const SEASON = '2025';

// ── LEAGUE IDs ──────────────────────────────────────────────────────────────
// Domestic Leagues
const DOMESTIC_LEAGUES = [
  39,   // Premier League (EPL) - England
  140,  // La Liga - Spain
  78,   // Bundesliga - Germany
  135,  // Serie A (Calcio) - Italy
  61,   // Ligue 1 - France
  94,   // Primeira Liga - Portugal
  203,  // Super Lig - Turkey
  88,   // Eredivisie - Netherlands
];

// European Competitions
const EUROPEAN_LEAGUES = [
  2,    // UEFA Champions League
  3,    // UEFA Europa League
  848,  // UEFA Europa Conference League
  531,  // UEFA Super Cup
];

const ALL_LEAGUES = [...DOMESTIC_LEAGUES, ...EUROPEAN_LEAGUES];

// ── The Odds API sport keys ──────────────────────────────────────────────────
const ODDS_SPORTS = [
  'soccer_epl',                              // EPL
  'soccer_spain_la_liga',                    // La Liga
  'soccer_germany_bundesliga',               // Bundesliga
  'soccer_italy_serie_a',                    // Serie A
  'soccer_france_ligue_one',                 // Ligue 1
  'soccer_portugal_primeira_liga',           // Liga Portugal
  'soccer_turkey_super_league',              // Super Lig
  'soccer_netherlands_eredivisie',           // Eredivisie
  'soccer_uefa_champs_league',               // UCL
  'soccer_uefa_europa_league',               // Europa League
  'soccer_uefa_europa_conference_league',    // Conference League
];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const now     = new Date();
    const today   = now.toISOString().slice(0, 10);
    const in7days = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);

    console.log(`Fetching fixtures ${today} → ${in7days}, season ${SEASON}`);
    console.log(`Leagues: ${ALL_LEAGUES.join(', ')}`);

    // 1. Fetch fixtures from ALL leagues in parallel
    const fixtureResults = await Promise.all(
      ALL_LEAGUES.map(lid =>
        fetch(
          `https://v3.football.api-sports.io/fixtures?league=${lid}&season=${SEASON}&from=${today}&to=${in7days}`,
          { headers: { 'x-apisports-key': SPORTS_KEY } }
        )
        .then(r => r.json())
        .catch(e => { console.log(`League ${lid} error:`, e.message); return { response: [] }; })
      )
    );

    let fixtures = fixtureResults.flatMap(r => Array.isArray(r.response) ? r.response : []);

    // Sort by date ascending
    fixtures.sort((a, b) => new Date(a.fixture?.date) - new Date(b.fixture?.date));

    console.log(`Fixtures from API-Football: ${fixtures.length}`);

    // Log errors per league
    fixtureResults.forEach((r, i) => {
      const lid = ALL_LEAGUES[i];
      const count = Array.isArray(r.response) ? r.response.length : 0;
      if (r.errors && Object.keys(r.errors).length > 0) {
        console.log(`League ${lid} API error:`, JSON.stringify(r.errors));
      } else {
        console.log(`League ${lid}: ${count} fixtures`);
      }
    });

    // 2. Fetch bookmaker odds from The Odds API
    const oddsResults = await Promise.all(
      ODDS_SPORTS.map(sp =>
        fetch(
          `https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal&daysFrom=7`
        )
        .then(r => r.json())
        .catch(() => [])
      )
    );

    const oddsData = oddsResults.flat().filter(o => o && o.id);
    console.log(`Odds entries: ${oddsData.length}`);

    // Build odds map
    const oddsMap = {};
    oddsData.forEach(o => {
      if (o.home_team && o.away_team) {
        oddsMap[norm(o.home_team + '_' + o.away_team)] = o;
        oddsMap[norm(o.away_team + '_' + o.home_team)] = o;
      }
    });

    // 3. Fixtures found — enrich with odds + team form
    if (fixtures.length > 0) {
      const enriched = await Promise.all(
        fixtures.slice(0, 25).map(async f => {
          const homeName = f.teams?.home?.name || '';
          const awayName = f.teams?.away?.name || '';
          const homeId   = f.teams?.home?.id;
          const awayId   = f.teams?.away?.id;

          // Team form — last 5 results
          let homeForm = [], awayForm = [];
          try {
            const [hRes, aRes] = await Promise.all([
              fetch(
                `https://v3.football.api-sports.io/fixtures?team=${homeId}&last=5&season=${SEASON}`,
                { headers: { 'x-apisports-key': SPORTS_KEY } }
              ).then(r => r.json()).catch(() => ({ response: [] })),
              fetch(
                `https://v3.football.api-sports.io/fixtures?team=${awayId}&last=5&season=${SEASON}`,
                { headers: { 'x-apisports-key': SPORTS_KEY } }
              ).then(r => r.json()).catch(() => ({ response: [] }))
            ]);
            homeForm = extractForm(hRes.response || [], homeId);
            awayForm = extractForm(aRes.response || [], awayId);
          } catch(e) {}

          // Match odds
          const key       = norm(homeName + '_' + awayName);
          const matchOdds = oddsMap[key] || null;
          let h2h = null, total = null;

          if (matchOdds && matchOdds.bookmakers?.length > 0) {
            matchOdds.bookmakers[0].markets?.forEach(m => {
              if (m.key === 'h2h') {
                h2h = {};
                m.outcomes?.forEach(o => {
                  if (o.name === homeName)    h2h.home = o.price;
                  else if (o.name === 'Draw') h2h.draw = o.price;
                  else                        h2h.away = o.price;
                });
              }
              if (m.key === 'totals') {
                total = {};
                m.outcomes?.forEach(o => {
                  if (o.name === 'Over')  { total.over = o.price; total.line = o.point || 2.5; }
                  if (o.name === 'Under')   total.under = o.price;
                });
              }
            });
          }

          // Tag the league name nicely
          const leagueName = getLeagueName(f.league?.id) || f.league?.name || 'Soccer';

          return { ...f, league: { ...f.league, name: leagueName }, homeForm, awayForm, h2h, total };
        })
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          fixtures:  enriched,
          total:     enriched.length,
          source:    'api-football + odds-api',
          season:    SEASON,
          dateRange: `${today} → ${in7days}`
        })
      };
    }

    // 4. Fallback — no API-Football data, use odds API as fixture source
    if (oddsData.length > 0) {
      console.log('Fallback: using odds API as fixture source');
      const oddsFixtures = oddsData.slice(0, 25).map(o => {
        let h2h = null, total = null;
        if (o.bookmakers?.length > 0) {
          o.bookmakers[0].markets?.forEach(m => {
            if (m.key === 'h2h') {
              h2h = {};
              m.outcomes?.forEach(out => {
                if (out.name === o.home_team)   h2h.home = out.price;
                else if (out.name === 'Draw')    h2h.draw = out.price;
                else                             h2h.away = out.price;
              });
            }
            if (m.key === 'totals') {
              total = {};
              m.outcomes?.forEach(out => {
                if (out.name === 'Over')  { total.over = out.price; total.line = out.point || 2.5; }
                if (out.name === 'Under')   total.under = out.price;
              });
            }
          });
        }
        return {
          fixture: { date: o.commence_time, id: o.id, status: { short: 'NS' } },
          league:  { name: getLeagueNameFromOdds(o.sport_key) || o.sport_title || 'Soccer', id: 0 },
          teams:   { home: { name: o.home_team, id: 0 }, away: { name: o.away_team, id: 0 } },
          goals:   { home: null, away: null },
          homeForm: [], awayForm: [],
          h2h, total
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          fixtures: oddsFixtures,
          total:    oddsFixtures.length,
          source:   'odds-api-fallback'
        })
      };
    }

    // 5. Nothing at all
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        fixtures: [],
        total:    0,
        message:  `No fixtures found from ${today} to ${in7days} for season ${SEASON}.`
      })
    };

  } catch (err) {
    console.error('Soccer function error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, fixtures: [] })
    };
  }
};

// ── HELPERS ──────────────────────────────────────────────────────────────────
function norm(str) {
  return str.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '');
}

function extractForm(fixtures, teamId) {
  return fixtures.slice(0, 5).map(f => {
    const isHome    = f.teams?.home?.id === teamId;
    const homeGoals = f.goals?.home ?? 0;
    const awayGoals = f.goals?.away ?? 0;
    if (isHome) return homeGoals > awayGoals ? 'W' : homeGoals === awayGoals ? 'D' : 'L';
    return awayGoals > homeGoals ? 'W' : awayGoals === homeGoals ? 'D' : 'L';
  });
}

function getLeagueName(id) {
  const map = {
    39:  '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',
    140: '🇪🇸 La Liga',
    78:  '🇩🇪 Bundesliga',
    135: '🇮🇹 Serie A',
    61:  '🇫🇷 Ligue 1',
    94:  '🇵🇹 Liga Portugal',
    203: '🇹🇷 Süper Lig',
    88:  '🇳🇱 Eredivisie',
    2:   '⭐ Champions League',
    3:   '🟠 Europa League',
    848: '🟢 Conference League',
    531: '⭐ UEFA Super Cup',
  };
  return map[id] || null;
}

function getLeagueNameFromOdds(sportKey) {
  const map = {
    soccer_epl:                            '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League',
    soccer_spain_la_liga:                  '🇪🇸 La Liga',
    soccer_germany_bundesliga:             '🇩🇪 Bundesliga',
    soccer_italy_serie_a:                  '🇮🇹 Serie A',
    soccer_france_ligue_one:               '🇫🇷 Ligue 1',
    soccer_portugal_primeira_liga:         '🇵🇹 Liga Portugal',
    soccer_turkey_super_league:            '🇹🇷 Süper Lig',
    soccer_netherlands_eredivisie:         '🇳🇱 Eredivisie',
    soccer_uefa_champs_league:             '⭐ Champions League',
    soccer_uefa_europa_league:             '🟠 Europa League',
    soccer_uefa_europa_conference_league:  '🟢 Conference League',
  };
  return map[sportKey] || null;
}
