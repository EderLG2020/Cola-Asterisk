require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const fse = require("fs-extra");
const mysql = require("mysql2/promise");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();

app.use(express.json());
app.use(cors());

let call_All = 0;
let totalCalls = 0;
let campaignId = null;
const callIdToTrunkMap = {};
const callIdToCampaignMap = {};

const OUTGOING_DIR = "./call";
const callQueuePhone = [];

let trunkStatus = {
  204: {
    channel_1: "",
    channel_2: "",
  },
  205: {
    channel_1: "",
    channel_2: "",
  },
  206: {
    channel_1: "",
    channel_2: "",
  },
};

const dbConfig = {
  host: "localhost",
  user: "root",
  password: "",
  database: "asterisk_app",
};

const pool = mysql.createPool(dbConfig);

const callEndQueue = [];
let isProcessingQueue = false;

function parseEventContent(content) {
  const evt = {};
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let line of lines) {
    line = line.replace(/,$/, "");

    let delimiter = ":";
    if (line.includes("=")) {
      delimiter = "=";
    } else if (line.includes(":")) {
      delimiter = ":";
    } else {
      continue;
    }

    const parts = line.split(delimiter);
    const key = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(delimiter).trim().replace(/^"|"$/g, "");
    evt[key] = value;
  }

  return evt;
}

async function processQueue1() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (callEndQueue.length > 0) {
    const evt = callEndQueue.shift();

    try {
      await processCallEndEvent(evt);
    } catch (error) {
      console.error(`❌ Error procesando evento CallEnd: ${error.message}`);
    }
  }

  isProcessingQueue = false;
}

async function processCallEndEvent(evt) {
  console.log("Evento recibido:", evt);

  const callId = evt["call_id"];
  const callStatus = evt["status"];
  const uniqueidEvt = evt["uniqueid"];
  const userEvent = evt["userevent"];
  const exten = evt["exten"];

  if (userEvent === "CallEnd" && exten === "h") {
    console.log(
      `🛑 CallEnd recibido: CALL_ID ${callId} - Estado ${callStatus}`
    );

    liberarTroncal(callId);

    if (callStatus === "SUCCESS") {
      await pool.execute(
        "UPDATE calls SET status = ?, uniqueid = ?, end_time = NOW() WHERE call_id = ?",
        [1, uniqueidEvt, callId]
      );
      console.log(`✅ Llamada CALL_ID ${callId} exitosa.`);
    } else if (callStatus === "FAILED") {
      await pool.execute(
        "UPDATE calls SET status = ?, end_time = NOW() WHERE call_id = ?",
        [2, callId]
      );
      console.log(`❌ Llamada CALL_ID ${callId} - fallida.`);
    }

    call_All++;

    if (call_All >= totalCalls) {
      console.log("====== Finalizado ======= ", totalCalls);
      await pool.execute(
        "UPDATE campaigns SET send_end_time = NOW() WHERE id = ?",
        [campaignId]
      );
      call_All = 0;
    }
  }
}

function handleCallEndEvent(fileContent) {
  const evt = parseEventContent(fileContent);
  callEndQueue.push(evt);
  processQueue1();
}

function findTrunkByCallId(callId) {
  return callIdToTrunkMap[callId];
}

function liberarTroncal(callId) {
  const trunk = findTrunkByCallId(callId);
  if (trunk && trunkStatus[trunk]) {
    delete callIdToTrunkMap[callId];
    delete callIdToCampaignMap[callId];

    // Liberar canal de troncal
    for (const channel in trunkStatus[trunk]) {
      if (trunkStatus[trunk][channel] === callId) {
        trunkStatus[trunk][channel] = "";
        break;
      }
    }

    console.log(`📞 Troncal ${trunk} liberada para CALL_ID ${callId}.`);
    processQueuePhone();
  } else {
    console.warn(`⚠️ No se encontró troncal para CALL_ID ${callId}.`);
  }
}

app.post("/FileDeleteIndex", async (req, res) => {
  const { indexCall } = req.body;

  if (!Array.isArray(indexCall) || indexCall.length === 0) {
    return res
      .status(400)
      .json({ error: "Debe proporcionar un array de índices válido." });
  }

  try {
    const files = await fs.readdir(OUTGOING_DIR);

    const sortedIndices = [...indexCall].sort((a, b) => b - a);
    const deletedFiles = [];

    for (const index of sortedIndices) {
      const fileToDelete = files[index];

      if (fileToDelete) {
        const filePath = path.join(OUTGOING_DIR, fileToDelete);

        const fileContent = await fs.readFile(filePath, "utf8");

        handleCallEndEvent(fileContent);

        await fs.unlink(filePath);
        deletedFiles.push(fileToDelete);
      } else {
        console.warn(
          `⚠️ Índice inválido: ${index}. No se encontró archivo para eliminar.`
        );
      }
    }

    res.status(200).json({
      message: "Archivos eliminados con éxito.",
      deletedFiles,
    });
  } catch (error) {
    console.error("❌ Error al eliminar archivos:", error.message);
    res.status(500).json({ error: "Ocurrió un error al eliminar archivos." });
  }
});

app.post("/start-call", async (req, res) => {
  const { campaign, numbers, audio_url } = req.body;
  if (!campaign || !numbers || !audio_url) {
    return res.status(400).json({ error: "Para campaña se requiere." });
  }

  try {
    const [campaignResult] = await pool.execute(
      "INSERT INTO campaigns (name, audio_url, send_start_time) VALUES (?, ?, NOW())",
      [campaign, audio_url]
    );
    const newCampaignId = campaignResult.insertId;
    campaignId = newCampaignId;

    totalCalls = numbers.length;

    const audioFileNameWithoutExtension = path.basename(
      audio_url,
      path.extname(audio_url)
    );

    for (const number of numbers) {
      const callId = uuidv4();
      await pool.execute(
        "INSERT INTO calls (campaign_id, number, status, call_id) VALUES (?, ?, 0, ?)",
        [newCampaignId, number, callId]
      );
      callQueuePhone.push({
        number,
        audioFileNameWithoutExtension,
        campaignId: newCampaignId,
        callId,
      });
    }

    console.log(`📊 Total de números: ${numbers.length}`);
    processQueuePhone();
    res.status(200).json({
      message: `Campaña "${campaign}" iniciada con ${numbers.length} números.`,
      campaignId: newCampaignId,
    });
  } catch (error) {
    console.error(`❌ Error al iniciar llamadas: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

async function createCallFile(number, trunk, campaignId, callId) {
  try {
    const callFilePath = path.join(
      OUTGOING_DIR,
      `llamada_${number}_${trunk}.call`
    );
    const callFileContent = `
Channel: SIP/${trunk}/2${number}
status: SUCCESS,
WaitTime: 45
Context: llamada_automatica
Extension: s
call_id=${callId}
exten: "h"
uniqueid:${number}.${number}
Priority: 1
userevent: "CallEnd",
DESTINATION_NUMBER:${number}
CAMPAIGN_ID:${campaignId}
TRUNK:${trunk}
FailureRetryTime: 0
FailureContext: llamada_automatica
`;
    await fse.writeFile(callFilePath, callFileContent);
    console.log(
      `📂 Archivo .call creado para el número ${number} en troncal ${trunk}: ${callFilePath}`
    );

    await pool.execute(
      "UPDATE calls SET start_time = NOW() WHERE call_id = ?",
      [callId]
    );
    console.log(
      `📞 Archivo creado para CALL_ID ${callId} en Troncal ${trunk}.`
    );
  } catch (error) {
    console.error("❌ Error en createCallFile:", error);
    throw error;
  }
}

async function processQueuePhone() {
  if (callQueuePhone.length === 0) return;

  const trunksAvailable = Object.keys(trunkStatus).filter((trunk) => {
    return Object.values(trunkStatus[trunk]).includes("");
  });

  if (trunksAvailable.length === 0) {
    console.log("⚠️ No hay troncales disponibles en este momento.");
    return;
  }

  for (const trunk of trunksAvailable) {
    const channels = Object.keys(trunkStatus[trunk]);

    for (const channel of channels) {
      if (trunkStatus[trunk][channel] !== "") continue;

      while (callQueuePhone.length > 0) {
        const callData = callQueuePhone.shift();
        const { number, campaignId, callId } = callData;

        // Asignamos la llamada al troncal y al canal
        trunkStatus[trunk][channel] = callId;

        // Mapeamos ANTES de crear el archivo
        callIdToTrunkMap[callId] = trunk;
        callIdToCampaignMap[callId] = campaignId;

        console.log(
          `🔄 Canal ${channel} en Troncal ${trunk} asignado a CALL_ID ${callId}.`
        );

        try {
          await createCallFile(number, trunk, campaignId, callId);
          console.log(
            `📞 Llamada procesada: Número ${number}, Troncal ${trunk}, Canal ${channel}, CALL_ID ${callId}.`
          );
          break;
        } catch (error) {
          console.error(
            `❌ Error procesando llamada en Troncal ${trunk}, Canal ${channel}: ${error.message}`
          );
          trunkStatus[trunk][channel] = "";
          delete callIdToTrunkMap[callId];
          delete callIdToCampaignMap[callId];
          callQueuePhone.unshift(callData);
          break;
        }
      }
    }
  }

  if (callQueuePhone.length > 0) {
    console.log("🔄 Quedan llamadas en la cola, procesando nuevamente...");
    setImmediate(processQueuePhone);
  } else {
    console.log("✅ Todas las llamadas en la cola han sido procesadas.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
