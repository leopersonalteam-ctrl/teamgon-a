// api/sync.js
const { Client } = require("@notionhq/client");
const { google } = require("googleapis");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");

const notion = new Client({ auth: NOTION_TOKEN });

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

function adicionarDias(data, dias) {
  const result = new Date(data);
  result.setDate(result.getDate() + dias);
  return result;
}

async function eventoExiste(nomeEvento, dataEvento) {
  try {
    const startOfDay = new Date(dataEvento);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(dataEvento);
    endOfDay.setHours(23, 59, 59, 999);

    const response = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      q: nomeEvento,
    });

    return response.data.items && response.data.items.length > 0;
  } catch (err) {
    console.error("Erro ao verificar evento:", err);
    return false;
  }
}

async function criarEvento(nomeEvento, dataEvento, descricao) {
  try {
    const existe = await eventoExiste(nomeEvento, dataEvento);
    
    if (existe) {
      console.log(`✓ Evento já existe: ${nomeEvento}`);
      return { status: "exists", nome: nomeEvento };
    }

    const event = {
      summary: nomeEvento,
      description: descricao,
      start: {
        date: dataEvento.toISOString().split("T")[0],
        timeZone: "America/Sao_Paulo",
      },
      end: {
        date: dataEvento.toISOString().split("T")[0],
        timeZone: "America/Sao_Paulo",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "notification", minutes: 24 * 60 },
          { method: "popup", minutes: 60 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      resource: event,
    });

    console.log(`✓ Evento criado: ${nomeEvento}`);
    return { status: "created", nome: nomeEvento, eventId: response.data.id };
  } catch (err) {
    console.error("Erro ao criar evento:", err);
    return { status: "error", nome: nomeEvento, erro: err.message };
  }
}

async function sincronizarNotionCalendar() {
  console.log("🔄 Iniciando sincronização Notion → Calendar...");
  
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
    });

    let resultados = {
      clientesProcessados: 0,
      eventosCriados: 0,
      eventosExistentes: 0,
      erros: 0,
      detalhes: [],
    };

    for (const page of response.results) {
      const props = page.properties;
      const nomeCliente = props["Nome do cliente"]?.title?.[0]?.plain_text || "Desconhecido";
      const ultimaAvaliacao = props["Última avaliação/foto"]?.date?.start;
      const fimPlano = props["fim do plano"]?.date?.start;
      const statusCliente = props["status do treino"]?.select?.name || "Desconhecido";

      if (statusCliente.toLowerCase() === "inativo") {
        console.log(`⊘ Cliente inativo: ${nomeCliente}`);
        continue;
      }

      resultados.clientesProcessados++;

      if (ultimaAvaliacao) {
        const dataReavaliacao = adicionarDias(new Date(ultimaAvaliacao), 45);
        const nomeEventoReavaliacao = `REAVALIAÇÃO - ${nomeCliente}`;
        const descricaoReavaliacao = `Reavaliação de composição corporal\nÚltima avaliação: ${new Date(ultimaAvaliacao).toLocaleDateString("pt-BR")}`;

        const resultadoReaval = await criarEvento(
          nomeEventoReavaliacao,
          dataReavaliacao,
          descricaoReavaliacao
        );

        if (resultadoReaval.status === "created") {
          resultados.eventosCriados++;
        } else if (resultadoReaval.status === "exists") {
          resultados.eventosExistentes++;
        } else {
          resultados.erros++;
        }

        resultados.detalhes.push(resultadoReaval);
      }

      if (fimPlano) {
        const dataRenovacao = adicionarDias(new Date(fimPlano), -30);
        const nomeEventoRenovacao = `RENOVAÇÃO - ${nomeCliente} (Vence: ${new Date(fimPlano).toLocaleDateString("pt-BR")})`;
        const descricaoRenovacao = `Lembrete de renovação\nData de término: ${new Date(fimPlano).toLocaleDateString("pt-BR")}`;

        const resultadoRenovacao = await criarEvento(
          nomeEventoRenovacao,
          dataRenovacao,
          descricaoRenovacao
        );

        if (resultadoRenovacao.status === "created") {
          resultados.eventosCriados++;
        } else if (resultadoRenovacao.status === "exists") {
          resultados.eventosExistentes++;
        } else {
          resultados.erros++;
        }

        resultados.detalhes.push(resultadoRenovacao);
      }
    }

    console.log("✅ Sincronização concluída!");
    return {
      sucesso: true,
      timestamp: new Date().toISOString(),
      ...resultados,
    };
  } catch (err) {
    console.error("❌ Erro na sincronização:", err);
    return {
      sucesso: false,
      timestamp: new Date().toISOString(),
      erro: err.message,
    };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido. Use POST." });
  }

  const token = req.headers["x-auth-token"];
  if (token !== process.env.SECRET_TOKEN) {
    return res.status(401).json({ erro: "Token inválido ou não fornecido." });
  }

  try {
    const resultado = await sincronizarNotionCalendar();
    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({
      sucesso: false,
      erro: err.message,
    });
  }
};
