const fetch = require('node-fetch');

const SPORTS_KEY = process.env.SPORTS_KEY || 'e294af2e2e1ffe6ac437596aefa83527';
const ODDS_KEY   = process.env.ODDS_KEY   || 'a0d9d10760d2ce5ce3e1706e22c95916';

const NBA_LEAGUE = 12;
const SEASON     = '2025-2026';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const today    = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const in3days  = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

    // Fetch NBA games for today and next 3 days
    const [todayRes, tomorrowRes, oddsRes] = await Promise.all([
      fetch(`https://v2.api-basketball.io/games?league=${NBA_LEAGUE}&season=${SEASON}&date=${today}`, {
        headers: { 'x-apisports-key': SPORTS_KEY, 'x-rapidapi-host': 'v2.api-basketball.io' }
      }).then(r => r.json()).catch(() => ({ response: [] })),
      fetch(`https://v2.api-basketball.io/games?league=${NBA_LEAGUE}&season=${SEASON}&date=${tomorrow}`, {
        headers: { 'x-apisports-key': SPORTS_KEY, 'x-rapidapi-host': 'v2.api-basketball.io' }
      }).then(r => r.json()).catch(() => ({ response: [] })),
      fetch(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${ODDS_KEY}&regions=us&markets=h2h,totals&oddsFormat=decimal&daysFrom=3`)
        .then(r => r.json()).catch(() => [])
    ]);

    let games = [
      ...(Array.isArray(todayRes.response) ? todayRes.response : []),
      ...(Array.isArray(tomorrowRes.response) ? tomorrowRes.response : [])
    ];
    console.log('NBA games found:', games.length);

    const oddsData = Array.isArray(oddsRes) ? oddsRes : [];
    console.log('NBA odds found:', oddsData.length);

    // Build odds map
    const oddsMap = {};
    oddsData.forEach(o => {
      if (o.home_team && o.away_team) {
        oddsMap[norm(o.home_team + '_' + o.away_team)] = o;
      }
    });

    // If no games from API-Basketball, use odds API as source
    if (games.length === 0 && oddsData.length > 0) {
      const oddsGames = oddsData.slice(0, 12).map(o => {
        let h2h = null, total = null;
        if (o.bookmakers?.length > 0) {
          o.bookmakers[0].markets?.forEach(m => {
            if (m.key === 'h2h') {
              h2h = {};
              m.outcomes?.forEach(out => {
                if (out.name === o.home_team) h2h.home = out.price;
                else h2h.away = out.price;
              });
            }
            if (m.key === 'totals') {
              total = {};
              m.outcomes?.forEach(out => {
                if (out.name === 'Over') { total.over = out.price; total.line = out.point || 220; }
                if (out.name === 'Under') total.under = out.price;
              });
            }
          });
        }
        return {
          teams: { home: { name: o.home_team }, away: { name: o.away_team } },
          date: o.commence_time,
          status: { short: 'NS' },
          scores: { home: { total: 0 }, away: { total: 0 } },
          h2h, total
        };
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ games: oddsGames, total: oddsGames.length, source: 'odds-api-only' })
      };
    }

    // Enrich games with odds
    const enriched = games.slice(0, 12).map(g => {
      const homeName = g.teams?.home?.name || '';
      const awayName = g.teams?.away?.name || '';
      const key = norm(homeName + '_' + awayName);
      const matchOdds = oddsMap[key] || null;
      let h2h = null, total = null;

      if (matchOdds && matchOdds.bookmakers?.length > 0) {
        matchOdds.bookmakers[0].markets?.forEach(m => {
          if (m.key === 'h2h') {
            h2h = {};
            m.outcomes?.forEach(o => {
              if (o.name === homeName) h2h.home = o.price;
              else h2h.away = o.price;
            });
          }
          if (m.key === 'totals') {
            total = {};
            m.outcomes?.forEach(o => {
              if (o.name === 'Over') { total.over = o.price; total.line = o.point || 220; }
              if (o.name === 'Under') total.under = o.price;
            });
          }
        });
      }

      return { ...g, h2h, total };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ games: enriched, total: enriched.length })
    };

  } catch (err) {
    console.error('Basketball error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, games: [] })
    };
  }
};

function norm(str) {
  return str.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '');
}
