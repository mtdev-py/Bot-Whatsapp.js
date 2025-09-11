const http = require("http");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot WhatsApp rodando 🚀");
}).listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
