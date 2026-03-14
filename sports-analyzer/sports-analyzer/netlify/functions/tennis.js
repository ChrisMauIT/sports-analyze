const fetch = require('node-fetch');

const ODDS_KEY = process.env.ODDS_KEY || 'a0d9d10760d2ce5ce3e1706e22c95916';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    // Get all currently active sports from The Odds API
    const allSports = await fetch(
      `https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}&all=true`
    ).then(r => r.json()).catch(() => []);

    // Filter only active tennis events
    const activeTennis = Array.isArray(allSports)
      ? allSports.filter(s => s.group === 'Tennis' && s.active).map(s => s.key)
      : [];

    console.log('Active tennis events:', activeTennis);

    if (activeTennis.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          matches: [],
          total: 0,
          message: 'No active tennis tournaments right now. Check back during Grand Slams or ATP/WTA events.'
        })
      };
    }

    // Fetch odds for all active tennis events
    const oddsResults = await Promise.all(
      activeTennis.slice(0, 6).map(sp =>
        fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&daysFrom=7`)
          .then(r => r.json())
          .catch(() => [])
      )
    );

    const allMatches = oddsResults.flat().filter(o => o && o.home_team);
    console.log('Tennis matches found:', allMatches.length);

    const enriched = allMatches.slice(0, 15).map(o => {
      let h2h = { home: null, away: null };
      if (o.bookmakers?.length > 0) {
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
        home_team:       o.home_team,
        away_team:       o.away_team,
        sport_title:     o.sport_title || 'Tennis',
        commence_time:   o.commence_time,
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
    console.error('Tennis error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, matches: [] })
    };
  }
};
