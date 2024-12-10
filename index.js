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
let call_All = 0; // Define call_All antes de su uso
let totalCalls = 0; // Define totalCalls antes de su uso
let campaignId = null; // Define campaignId antes de su uso
const callIdToTrunkMap = {}; // Agregar definición para callIdToTrunkMap
const callIdToCampaignMap = {}; // También agregar definición para callIdToCampaignMap

const OUTGOING_DIR = "./call";
const callQueuePhone = []; // Agregar definición para callQueuePhone

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
  host: "localhost", // o 127.0.0.1
  user: "root",
  password: "",
  database: "asterisk_app",
};

const pool = mysql.createPool(dbConfig);

const callEndQueue = [];
let isProcessingQueue = false;

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
  // Convertir a objeto si es necesario
  if (typeof evt === "string") {
    try {
      evt = JSON.parse(evt); // Intentar convertir el string en un objeto JSON
    } catch (error) {
      console.error(`❌ Error al convertir el evento a JSON: ${error.message}`);
      return; // Terminar la función si no se puede parsear
    }
  }

  console.log("Evento recibido:", evt);

  const callId = evt["call_id"];
  const callStatus = evt["status"];
  const uniqueidEvt = evt["uniqueid"];

  if (evt["userevent"] === "CallEnd" && evt["exten"] === "h") {
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

function handleCallEndEvent(evt) {
  callEndQueue.push(evt);
  processQueue1();
}

function liberarTroncal(callId) {
  const trunk = findTrunkByCallId(callId);
  if (trunk && trunkStatus[trunk]) {
    trunkStatus[trunk].busy -= 1;
    delete callIdToTrunkMap[callId];
    delete callIdToCampaignMap[callId];
    console.log(
      `📞 Troncal ${trunk} liberada para CALL_ID ${callId}. Ahora tiene ${trunkStatus[trunk].busy} llamadas activas.`
    );
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

    const numbersWithUUIDs = [];

    // Extraer el nombre del archivo sin la extensión
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
        audioFileNameWithoutExtension, // Asignamos aquí el valor
        campaignId: newCampaignId,
        callId,
      });

      numbersWithUUIDs.push({ number, callId });
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
    callIdToTrunkMap[callId] = trunk;
    callIdToCampaignMap[callId] = campaignId;
    await pool.execute(
      "UPDATE calls SET start_time = NOW() WHERE call_id = ?",
      [callId]
    );
    console.log(`🔗 Mapeando CALL_ID ${callId} a Troncal ${trunk}.`);
  } catch (error) {
    console.error("❌ Error en createCallFile:", error);
    throw error;
  }
}

async function processQueuePhone() {
  if (callQueuePhone.length === 0) return;

  const trunksAvailable = Object.keys(trunkStatus).filter((trunk) => {
    return Object.values(trunkStatus[trunk]).includes(""); // Filtra troncos disponibles
  });

  if (trunksAvailable.length === 0) {
    console.log("⚠️ No hay troncales disponibles en este momento.");
    return;
  }

  // Asignar llamadas a los troncales disponibles
  for (const trunk of trunksAvailable) {
    const channels = Object.keys(trunkStatus[trunk]);

    for (const channel of channels) {
      if (trunkStatus[trunk][channel] !== "") continue;

      while (callQueuePhone.length > 0) {
        const callData = callQueuePhone.shift();
        const { number, campaignId, callId } = callData;

        trunkStatus[trunk][channel] = callId;
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
          trunkStatus[trunk][channel] = ""; // Liberar canal en caso de error
          callQueuePhone.unshift(callData); // Reinsertar en la cola
          break;
        }
      }
    }
  }

  // Reintentar si aún hay llamadas en la cola
  if (callQueuePhone.length > 0) {
    console.log("🔄 Quedan llamadas en la cola, procesando nuevamente...");
    setImmediate(processQueuePhone); // Usar setImmediate para procesar de inmediato sin bloquear el hilo
  } else {
    console.log("✅ Todas las llamadas en la cola han sido procesadas.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
