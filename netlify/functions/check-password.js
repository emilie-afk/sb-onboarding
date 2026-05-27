// check-password.js
// Validates team passwords and admin passwords.
//
// Environment variables to set in Netlify → Site configuration → Environment variables:
//
//   Team passwords (employees unlock their team section):
//     PASSWORD_MARKETING
//     PASSWORD_CUSTOMERSERVICE
//     PASSWORD_SEO
//     PASSWORD_DESIGN
//     PASSWORD_VIDEO
//
//   Admin passwords (add / remove Google Drive files):
//     PASSWORD_ADMIN              ← global admin, can manage ALL teams
//     PASSWORD_ADMIN_MARKETING    ← can only manage Marketing files
//     PASSWORD_ADMIN_CUSTOMERSERVICE
//     PASSWORD_ADMIN_SEO
//     PASSWORD_ADMIN_DESIGN
//     PASSWORD_ADMIN_VIDEO

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false }) };
  }

  let team, teamName, password;
  try {
    ({ team, teamName, password } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false }) };
  }

  if (!team || !password) {
    return { statusCode: 400, body: JSON.stringify({ success: false }) };
  }

  let correct;

  if (team === 'admin') {
    // Accept EITHER the global admin password OR the team-specific admin password
    const globalAdmin = process.env.PASSWORD_ADMIN;
    const teamKey     = teamName
      ? 'PASSWORD_ADMIN_' + teamName.toUpperCase().replace(/[^A-Z]/g, '')
      : null;
    const teamAdmin   = teamKey ? process.env[teamKey] : null;

    const matchesGlobal = globalAdmin && password === globalAdmin;
    const matchesTeam   = teamAdmin   && password === teamAdmin;

    return {
      statusCode: 200,
      body: JSON.stringify({ success: matchesGlobal || matchesTeam }),
    };
  } else {
    // Regular team password
    const envKey = 'PASSWORD_' + team.toUpperCase().replace(/[^A-Z]/g, '');
    correct = process.env[envKey];

    if (!correct) {
      return { statusCode: 401, body: JSON.stringify({ success: false }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: password === correct }),
    };
  }
};
