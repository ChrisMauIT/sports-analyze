const fetch = require('node-fetch');

const SPORTS_KEY = process.env.SPORTS_KEY || 'e294af2e2e1ffe6ac437596aefa83527';
const ODDS_KEY   = process.env.ODDS_KEY   || 'a0d9d10760d2ce5ce3e1706e22c95916';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const [gamesRes, oddsRes] = await Promise.all([
      fetch(`https://v2.api-basketball.io/games?league=12&season=2024-2025&date=${today}`, {
        headers: { 'x-apisports-key': SPORTS_KEY, 'x-rapidapi-host': 'v2.api-basketball.io' }
      }).then(r => r.json()).catch(() => ({ response: [] })),
      fetch(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${ODDS_KEY}&regions=us&markets=h2h,totals&oddsFormat=decimal`)
        .then(r => r.json()).catch(() => [])
    ]);

    // Try tomorrow if today empty
    let games = Array.isArray(gamesRes.response) ? gamesRes.response : [];
    if (games.length === 0) {
      const tomorrowRes = await fetch(
        `https://v2.api-basketball.io/games?league=12&season=2024-2025&date=${tomorrow}`,
        { headers: { 'x-apisports-key': SPORTS_KEY, 'x-rapidapi-host': 'v2.api-basketball.io' } }
      ).then(r => r.json()).catch(() => ({ response: [] }));
      games = Array.isArray(tomorrowRes.response) ? tomorrowRes.response : [];
    }

    const oddsData = Array.isArray(oddsRes) ? oddsRes : [];
    const oddsMap = {};
    oddsData.forEach(o => {
      if (o.home_team && o.away_team) {
        const key = normalize(o.home_team + '_' + o.away_team);
        oddsMap[key] = o;
      }
    });

    const enriched = games.slice(0, 15).map(g => {
      const homeName = g.teams?.home?.name || '';
      const awayName = g.teams?.away?.name || '';
      const key = normalize(homeName + '_' + awayName);
      const matchOdds = oddsMap[key] || null;

      let h2h = null, total = null;
      if (matchOdds && matchOdds.bookmakers && matchOdds.bookmakers.length > 0) {
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
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

function normalize(str) {
  return str.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '');
}
