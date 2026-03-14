const fetch = require('node-fetch');

const SPORTS_KEY = process.env.SPORTS_KEY || 'e294af2e2e1ffe6ac437596aefa83527';
const ODDS_KEY   = process.env.ODDS_KEY   || 'a0d9d10760d2ce5ce3e1706e22c95916';

// Top soccer league IDs
const LEAGUES = [39, 140, 135, 78, 61, 2, 3];
// EPL=39, LaLiga=140, SerieA=135, Bundesliga=78, Ligue1=61, UCL=2, EuropaLeague=3

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const in3days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

    // Fetch fixtures from all top leagues for next 3 days
    const fixturePromises = LEAGUES.map(lid =>
      fetch(`https://v3.football.api-sports.io/fixtures?league=${lid}&season=2024&from=${today}&to=${in3days}`, {
        headers: { 'x-apisports-key': SPORTS_KEY }
      }).then(r => r.json()).catch(() => ({ response: [] }))
    );

    // Fetch live odds from The Odds API for top soccer leagues
    const oddsSports = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_uefa_champs_league'];
    const oddsPromises = oddsSports.map(sp =>
      fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal&daysFrom=3`)
        .then(r => r.json()).catch(() => [])
    );

    const [fixtureResults, oddsResults] = await Promise.all([
      Promise.all(fixturePromises),
      Promise.all(oddsPromises)
    ]);

    const fixtures = fixtureResults.flatMap(r => Array.isArray(r.response) ? r.response : []);
    const oddsData = oddsResults.flat().filter(o => o && o.id);

    // Build odds map by team name key
    const oddsMap = {};
    oddsData.forEach(o => {
      if (o.home_team && o.away_team) {
        const key = normalize(o.home_team + '_' + o.away_team);
        oddsMap[key] = o;
      }
    });

    // Also fetch team stats for H2H for top fixtures
    const enrichedFixtures = await Promise.all(
      fixtures.slice(0, 20).map(async f => {
        const homeId = f.teams?.home?.id;
        const awayId = f.teams?.away?.id;
        const leagueId = f.league?.id;

        // Fetch last 5 matches form for each team
        let homeForm = [], awayForm = [];
        try {
          const [hRes, aRes] = await Promise.all([
            fetch(`https://v3.football.api-sports.io/fixtures?team=${homeId}&last=5&league=${leagueId}&season=2024`, {
              headers: { 'x-apisports-key': SPORTS_KEY }
            }).then(r => r.json()),
            fetch(`https://v3.football.api-sports.io/fixtures?team=${awayId}&last=5&league=${leagueId}&season=2024`, {
              headers: { 'x-apisports-key': SPORTS_KEY }
            }).then(r => r.json())
          ]);

          homeForm = extractForm(hRes.response || [], homeId);
          awayForm = extractForm(aRes.response || [], awayId);
        } catch(e) {}

        // Match odds from oddsMap
        const homeName = f.teams?.home?.name || '';
        const awayName = f.teams?.away?.name || '';
        const oddsKey = normalize(homeName + '_' + awayName);
        const matchOdds = oddsMap[oddsKey] || null;

        let h2h = null, total = null;
        if (matchOdds && matchOdds.bookmakers && matchOdds.bookmakers.length > 0) {
          matchOdds.bookmakers[0].markets?.forEach(m => {
            if (m.key === 'h2h') {
              h2h = {};
              m.outcomes?.forEach(o => {
                if (o.name === homeName) h2h.home = o.price;
                else if (o.name === 'Draw') h2h.draw = o.price;
                else h2h.away = o.price;
              });
            }
            if (m.key === 'totals') {
              total = {};
              m.outcomes?.forEach(o => {
                if (o.name === 'Over') { total.over = o.price; total.line = o.point || 2.5; }
                if (o.name === 'Under') total.under = o.price;
              });
            }
          });
        }

        return { ...f, homeForm, awayForm, h2h, total };
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ fixtures: enrichedFixtures, total: enrichedFixtures.length })
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

function extractForm(fixtures, teamId) {
  return fixtures.slice(0, 5).map(f => {
    const isHome = f.teams?.home?.id === teamId;
    const homeGoals = f.goals?.home ?? 0;
    const awayGoals = f.goals?.away ?? 0;
    if (isHome) return homeGoals > awayGoals ? 'W' : homeGoals === awayGoals ? 'D' : 'L';
    return awayGoals > homeGoals ? 'W' : awayGoals === homeGoals ? 'D' : 'L';
  });
}
