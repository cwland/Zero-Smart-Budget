import "dotenv/config";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";

const { db } = createDb(process.env.DATABASE_URL!);
await runMigrations(db);

const app = buildApp({ db, jwtSecret: process.env.JWT_SECRET ?? "", logger: true });
const port = Number(process.env.PORT ?? 4000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
