import readline from 'readline';
import { generateUserId, hashPassword } from './auth.js';
import {
  initDatabase,
  getUserByUsername,
  createUser,
  updateUserFields,
  deleteUserSessionsByUserId,
} from './db.js';

// 与 reset-admin.ts / routes/auth.ts 保持一致的下限。
const MIN_PASSWORD_LENGTH = 8;

function printUsage(): void {
  console.error('Usage:');
  console.error(
    '  node dist/admin-account-cli.js create <username> [password]',
  );
  console.error(
    '  node dist/admin-account-cli.js passwd <username> [new_password]',
  );
  console.error('');
  console.error(
    'If password is omitted, it is prompted interactively (hidden input).',
  );
  console.error(
    'Username is stored lowercase. Password must be >= 8 chars.',
  );
  console.error(
    'passwd only accepts admin accounts; use the Web admin UI to manage non-admin users.',
  );
}

// 隐藏输入：raw mode 下逐字符读取，回车结束，Ctrl-C 退出 130，
// Backspace 删除。非 TTY（管道喂入）退化为普通 readline，调用方需自行注意
// 不要把密码写进 shell history。
function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.replace(/\r?\n$/, ''));
      });
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let password = '';
    const onData = (buf: Buffer): void => {
      const str = buf.toString();
      for (const ch of str) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(password);
          return;
        }
        if (code === 3) {
          process.exit(130);
        }
        if (code === 127 || code === 8) {
          if (password.length > 0) password = password.slice(0, -1);
          continue;
        }
        if (code >= 32 && code < 127) {
          password += ch;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function createAdmin(username: string, password: string): Promise<void> {
  const existing = getUserByUsername(username);
  if (existing) {
    console.error(
      `[FAIL] Username "${username}" already exists (role=${existing.role}, status=${existing.status}).`,
    );
    console.error('       Use "passwd" subcommand to reset its password.');
    process.exit(2);
  }
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  createUser({
    id: generateUserId(),
    username,
    password_hash: passwordHash,
    display_name: username,
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
    notes: 'Created by admin-account-cli',
  });
  console.log(`[OK] Created admin account: ${username}`);
}

async function changePassword(
  username: string,
  newPassword: string,
): Promise<void> {
  const user = getUserByUsername(username);
  if (!user) {
    console.error(`[FAIL] Username "${username}" not found.`);
    process.exit(2);
  }
  if (user.role !== 'admin') {
    console.error(
      `[FAIL] Username "${username}" is not an admin (role=${user.role}).`,
    );
    console.error('       This script only manages admin accounts.');
    process.exit(2);
  }
  const passwordHash = await hashPassword(newPassword);
  updateUserFields(user.id, {
    password_hash: passwordHash,
    status: 'active',
    must_change_password: false,
    disable_reason: null,
    deleted_at: null,
  });
  deleteUserSessionsByUserId(user.id);
  console.log(`[OK] Password updated for admin: ${username}`);
  console.log('     All existing sessions revoked.');
}

async function main(): Promise<void> {
  initDatabase();
  const [subcommand, usernameArg, passwordArg] = process.argv.slice(2);

  if (!subcommand || !usernameArg) {
    printUsage();
    process.exit(1);
  }

  const username = usernameArg.trim().toLowerCase();
  if (!username) {
    console.error('[FAIL] Username cannot be empty.');
    process.exit(1);
  }

  let password = passwordArg;
  if (!password) {
    password = await readPassword('Password (>= 8 chars): ');
    if (!password) {
      console.error('[FAIL] No password provided.');
      process.exit(1);
    }
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `[FAIL] Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    process.exit(1);
  }

  switch (subcommand) {
    case 'create':
      await createAdmin(username, password);
      break;
    case 'passwd':
      await changePassword(username, password);
      break;
    default:
      console.error(`[FAIL] Unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

void main();
