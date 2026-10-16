import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port between 1 and 65535.");
}

app.listen(port, () => {
  console.log(`Flex Bar API listening on port ${port}.`);
});
