// get-guide.js — returns the private onboarding guide to a signed-in session.
//
// GET → { guide }   (any signed-in team member or admin; same rule as the handbook link)
// 401 without a valid session, 503 when the guide is not configured on the server.

const { json, errorResponse } = require('../lib/http');
const { canReadGlobal } = require('../lib/session');
const { authenticate } = require('../lib/auth');
const { loadGuide, GuideError } = require('../lib/guide');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'method_not_allowed' }, { headers: { Allow: 'GET' } });
  }
  try {
    const { session } = await authenticate(event);
    if (!session) return json(401, { error: 'unauthenticated' });
    if (!canReadGlobal(session)) return json(403, { error: 'forbidden' });
    let guide;
    try {
      guide = loadGuide();
    } catch (err) {
      if (err instanceof GuideError) {
        console.error(JSON.stringify({ fn: 'get-guide', event: err.code }));
        return json(503, { error: 'guide_not_configured' });
      }
      throw err;
    }
    return json(200, { guide });
  } catch (err) {
    return errorResponse(err, 'get-guide');
  }
};
