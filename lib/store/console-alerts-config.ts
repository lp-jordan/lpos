import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'console-alerts-config.json');

export interface ConsoleAlertsConfig {
  slackBotToken: string | null;
  recipients: Array<{ userId: string; name: string; slackEmail: string }>;
}

export function readConsoleAlertsConfig(): ConsoleAlertsConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as ConsoleAlertsConfig;
    }
  } catch { /* fall through */ }
  return { slackBotToken: null, recipients: [] };
}

export function writeConsoleAlertsConfig(cfg: ConsoleAlertsConfig) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
