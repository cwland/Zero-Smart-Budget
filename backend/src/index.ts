import "dotenv/config";
import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/api/health", async () => ({ status: "ok", app: "Cory's Dollar" }));

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
