// Reset the login password from the server, no email needed.
//   npm run reset-password
//   docker compose exec api npm run reset-password
import "dotenv/config";
import readline from "node:readline";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../lib/auth.js";

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Don't echo what's typed
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    })
  );
}

const { db, pool } = createDb(process.env.DATABASE_URL!);
try {
  await runMigrations(db);
  const [user] = await db.select().from(users).limit(1);
  if (!user) {
    console.log("No account yet. Open the app to create one.");
  } else {
    console.log(`Resetting the password for "${user.username}".`);
    const pw = process.env.NEW_PASSWORD ?? (await ask("New password: ", true));
    const again = process.env.NEW_PASSWORD ?? (await ask("Again: ", true));
    if (pw !== again) throw new Error("Passwords don't match");
    if (pw.length < 8) throw new Error("Password must be at least 8 characters");
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(pw), tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, user.id));
    console.log("Password changed. All devices were signed out.");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
