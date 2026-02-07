import express from "express";
import path from "path";
import { fileURLToPath} from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3000;
app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running:
  - http://localhost:${PORT}
  - http://172.20.10.2:${PORT} (LAN)`);
});