// Monta a mensagem do WhatsApp conforme o APP que o cliente escolheu no funil,
// extraindo do `reply` do painel a URL/credenciais corretas de cada aplicativo.

// Extrai os dados relevantes do texto de resposta do painel.
export function parseReply(reply = '', dns = '', username = '', password = '') {
  const grab = (re) => { const m = String(reply).match(re); return m ? m[1].trim() : ''; };

  const smartersUrl = grab(/SMARTERS[\s\S]*?URL:\*?\s*(https?:\/\/\S+)/i) || 'http://pthdtv.top';
  const xcUrl = grab(/XCIPTV[\s\S]*?URL:\*?\s*(https?:\/\/\S+)/i) || dns || '';

  // Links M3U completos (.TS e .MPEGTS) — o cliente testa os dois
  const base = xcUrl || dns || '';
  let m3uTs = grab(/Link \(M3U \.TS\):\*?\s*(https?:\/\/\S+)/i);
  let m3uMpegts = grab(/Link \(M3U \.MPEGTS\):\*?\s*(https?:\/\/\S+)/i);
  if (!m3uTs && base && username) m3uTs = `${base}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
  if (!m3uMpegts && base && username) m3uMpegts = `${base}/get.php?username=${username}&password=${password}&type=m3u_plus&output=mpegts`;

  const rpCode = grab(/SERVIDOR:\s*\*?(\d{4,})/i) || '38155545';

  return { smartersUrl, xcUrl, m3uTs, m3uMpegts, rpCode };
}

// Estilo de credencial conforme o app.
function appStyle(app = '') {
  const a = String(app).toLowerCase();
  if (a.includes('smarters')) return 'smarters';
  if (a.includes('rp725') || a.includes('rp 725')) return 'rp725';
  if (a.includes('assist')) return 'm3u';
  if (a.includes('ibo')) return 'm3u';
  return 'xc'; // XC IPTV, VU IPTV Player e demais universais
}

export function buildTestMessage({ app, name, username, password, expiresLabel, reply, dns }) {
  const p = parseReply(reply, dns, username, password);
  const first = (name || '').split(' ')[0] || 'tudo certo';
  const style = appStyle(app);
  const appName = app || 'seu app de IPTV';

  const header =
    `🎬 *HyperFlick* — seu TESTE GRÁTIS está liberado, ${first}! 🧡\n\n` +
    `⏳ *Validade:* ${expiresLabel}\n\n`;

  let body;
  if (style === 'smarters') {
    body =
      `📲 *Como acessar no ${appName}:*\n` +
      `Abra o app e escolha *"Login com Xtream Codes"*, depois preencha:\n\n` +
      `✅ *Nome:* ${name || 'HyperFlick'}\n` +
      `✅ *Usuário:* ${username}\n` +
      `✅ *Senha:* ${password}\n` +
      `✅ *URL:* ${p.smartersUrl}`;
  } else if (style === 'rp725') {
    body =
      `📲 *Como acessar no RP725:*\n` +
      `1️⃣ Abra o app e digite o *código do servidor:* ${p.rpCode}\n` +
      `2️⃣ Depois entre com:\n\n` +
      `✅ *Usuário:* ${username}\n` +
      `✅ *Senha:* ${password}`;
  } else if (style === 'm3u') {
    body =
      `📲 *Como acessar no ${appName}:*\n` +
      `Adicione a lista por um dos *links M3U* abaixo. *Teste os dois* e use o que abrir certinho no seu aparelho:\n\n` +
      `🔗 *Opção 1 (M3U .TS):*\n${p.m3uTs}\n\n` +
      `🔗 *Opção 2 (M3U .MPEGTS):*\n${p.m3uMpegts}`;
  } else {
    // xc / universal
    body =
      `📲 *Como acessar no ${appName}:*\n` +
      `Adicione uma lista no modo *Xtream Codes* com:\n\n` +
      `✅ *URL:* ${p.xcUrl}\n` +
      `✅ *Usuário:* ${username}\n` +
      `✅ *Senha:* ${password}`;
  }

  const footer = `\n\nQualquer dúvida na instalação, é só chamar aqui! 👇`;
  return header + body + footer;
}
