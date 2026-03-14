const fetch = require('node-fetch');

const ODDS_KEY = process.env.ODDS_KEY || 'a0d9d10760d2ce5ce3e1706e22c95916';

const TENNIS_SPORTS = [
  'tennis_atp_french_open',
  'tennis_wta_french_open',
  'tennis_atp_us_open',
  'tennis_wta_us_open',
  'tennis_atp_wimbledon',
  'tennis_wta_wimbledon',
  'tennis_atp_aus_open',
  'tennis_wta_aus_open'
];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    // First check which tennis events are currently active
    const activeSports = await fetch(
      `https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}&all=true`
    ).then(r => r.json()).catch(() => []);

    const activeTennis = Array.isArray(activeSports)
      ? activeSports.filter(s => s.group === 'Tennis' && s.active).map(s => s.key)
      : TENNIS_SPORTS;

    if (activeTennis.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ matches: [], total: 0, message: 'No active tennis events right now' })
      };
    }

    // Fetch odds for all active tennis events
    const oddsPromises = activeTennis.slice(0, 5).map(sp =>
      fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`)
        .then(r => r.json()).catch(() => [])
    );

    const oddsResults = await Promise.all(oddsPromises);
    const allMatches = oddsResults.flat().filter(o => o && o.home_team);

    const enriched = allMatches.slice(0, 15).map(o => {
      let h2h = { home: null, away: null };
      if (o.bookmakers && o.bookmakers.length > 0) {
        o.bookmakers[0].markets?.forEach(m => {
          if (m.key === 'h2h') {
            m.outcomes?.forEach(out => {
              if (out.name === o.home_team) h2h.home = out.price;
              else h2h.away = out.price;
            });
          }
        });
      }
      return {
        home_team: o.home_team,
        away_team: o.away_team,
        sport_title: o.sport_title || 'Tennis',
        commence_time: o.commence_time,
        h2h,
        bookmakers_count: o.bookmakers?.length || 0
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ matches: enriched, total: enriched.length })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
