// Entrada para rodar LOCALMENTE (npm start). Na Vercel usa-se api/index.js.
import { app } from './app.js';
import { config, configWarnings } from './config.js';

app.listen(config.port, () => {
  console.log(`\n🧡 HyperFlick rodando em ${config.publicUrl}`);
  console.log(`   Funil:  ${config.publicUrl}/`);
  console.log(`   Painel: ${config.publicUrl}/painel`);
  const w = configWarnings();
  if (w.length) {
    console.log('\n⚠️  Avisos de configuração:');
    w.forEach((x) => console.log('   - ' + x));
  }
  console.log('');
});
