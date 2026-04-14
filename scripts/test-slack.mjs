/**
 * Quick Slack integration smoke test.
 * Usage: node scripts/test-slack.mjs your@email.com
 */

const token = process.env.SLACK_BOT_TOKEN;
const email = process.argv[2];

if (!token) {
  console.error('❌  SLACK_BOT_TOKEN is not set in your environment.');
  process.exit(1);
}

if (!email) {
  console.error('Usage: node scripts/test-slack.mjs your@email.com');
  process.exit(1);
}

console.log(`Looking up Slack user for ${email}...`);

const lookupRes = await fetch(
  `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const lookup = await lookupRes.json();

if (!lookup.ok) {
  console.error(`❌  Could not resolve Slack user: ${lookup.error}`);
  process.exit(1);
}

const slackUserId = lookup.user.id;
console.log(`✅  Found Slack user: ${lookup.user.real_name} (${slackUserId})`);
console.log('Sending test DM...');

const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    channel: slackUserId,
    text: 'You were assigned a task by Test\n> Build out the show open graphics',
  }),
});
const msg = await msgRes.json();

if (!msg.ok) {
  console.error(`❌  DM failed: ${msg.error}`);
  process.exit(1);
}

console.log('✅  DM sent successfully. Check your Slack DMs.');
