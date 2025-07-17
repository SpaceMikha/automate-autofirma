const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
const port = 3000;

// Middleware
app.use(express.static("."));
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Directorios
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Almacenamiento temporal de firmas
const signatures = {};

// Headers CORS y ngrok - IMPORTANTE: debe ir ANTES de las rutas
app.use((req, res, next) => {
  // Headers para CORS
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning");
  
  // Headers específicos para ngrok
  res.header("ngrok-skip-browser-warning", "true");
  
  // Si ngrok envía el header ngrok-skip-browser-warning, lo procesamos
  if (req.headers['ngrok-skip-browser-warning']) {
    console.log("Detectada solicitud de ngrok");
  }
  
  // Log de todas las solicitudes
  console.log(`${req.method} ${req.path} - Headers:`, req.headers['user-agent']);
  
  next();
});

// Registrar una firma pendiente (para método con datos embebidos)
app.post("/register-signature", (req, res) => {
  const { id, fileName } = req.body;
  
  console.log(`Registrando firma pendiente - ID: ${id}, Archivo: ${fileName}`);
  
  signatures[id] = {
    status: 'pending',
    fileName: fileName,
    timestamp: Date.now()
  };
  
  res.json({ success: true });
});

// Preparar PDF - Asegurar que devuelve la URL correcta
app.post("/prepare-pdf", async (req, res) => {
  try {
    const { data, fileName } = req.body;
    const timestamp = Date.now();
    const id = `sign_${timestamp}`;
    const inputPath = path.join(uploadsDir, `${id}.pdf`);

    // Guardar el PDF
    fs.writeFileSync(inputPath, Buffer.from(data, "base64"));

    // Verificar que el archivo se guardó correctamente
    if (!fs.existsSync(inputPath)) {
      throw new Error("No se pudo guardar el archivo");
    }

    const stats = fs.statSync(inputPath);
    console.log(`Archivo ${fileName} guardado - Tamaño: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // Guardar información del proceso
    signatures[id] = {
      status: 'pending',
      filePath: inputPath,
      fileName: fileName,
      timestamp: timestamp
    };

    // IMPORTANTE: Asegurarse de que la URL sea la de LocalTunnel
    const fileUrl = `${req.protocol}://${req.get('host')}/pdf/${id}`;
    
    console.log(`Archivo preparado - ID: ${id}`);
    console.log(`URL del archivo: ${fileUrl}`);
    console.log(`Archivo existe: ${fs.existsSync(inputPath)}`);
    
    res.json({ fileUrl, id });
  } catch (err) {
    console.error("Error al preparar PDF:", err);
    res.status(500).json({ error: err.message || "Error al preparar el PDF" });
  }
});

// Sesiones de firma
const sessions = {};

// Crear sesión de firma
app.post("/afirma/create-session", (req, res) => {
  const { fileName, fileSize } = req.body;
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  sessions[sessionId] = {
    fileName: fileName,
    fileSize: fileSize,
    status: 'created',
    createdAt: Date.now()
  };
  
  console.log(`Nueva sesión creada: ${sessionId} para ${fileName}`);
  
  res.json({
    sessionId: sessionId,
    uploadUrl: `/afirma/session/${sessionId}/upload`,
    downloadUrl: `/afirma/session/${sessionId}/download`
  });
});

// Subir archivo a la sesión
app.put("/afirma/session/:sessionId/upload", express.raw({ type: 'application/pdf', limit: '50mb' }), (req, res) => {
  const { sessionId } = req.params;
  
  if (!sessions[sessionId]) {
    return res.status(404).send("Sesión no encontrada");
  }
  
  sessions[sessionId].originalFile = req.body;
  sessions[sessionId].status = 'uploaded';
  
  console.log(`Archivo subido para sesión ${sessionId}: ${req.body.length} bytes`);
  res.send("OK");
});

// Servir archivo temporal para AutoFirma
app.get("/afirma/temp/:sessionId/document.pdf", (req, res) => {
  const { sessionId } = req.params;
  
  console.log(`\n=== AUTOFIRMA SOLICITANDO ARCHIVO TEMPORAL ===`);
  console.log(`Session ID: ${sessionId}`);
  console.log(`User-Agent: ${req.headers['user-agent']}`);
  
  const session = sessions[sessionId];
  if (!session || !session.originalFile) {
    console.error("Archivo no encontrado para sesión:", sessionId);
    return res.status(404).send("Archivo no encontrado");
  }
  
  // Servir el PDF con los headers correctos
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${session.fileName}"`);
  res.setHeader('Content-Length', session.originalFile.length);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.send(session.originalFile);
  
  console.log(`✓ PDF enviado a AutoFirma: ${session.originalFile.length} bytes`);
  session.status = 'sent_to_autofirma';
});

// Recibir archivo firmado de AutoFirma
app.post("/afirma/store/:sessionId", express.text({ type: '*/*', limit: '50mb' }), (req, res) => {
  const { sessionId } = req.params;
  
  console.log(`\n=== RECIBIENDO ARCHIVO FIRMADO ===`);
  console.log(`Session ID: ${sessionId}`);
  console.log(`Content-Type: ${req.headers['content-type']}`);
  console.log(`Body length: ${req.body.length}`);
  
  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).send("Sesión no encontrada");
  }
  
  // AutoFirma puede enviar el archivo de diferentes formas
  let signedData = req.body;
  
  if (typeof signedData === 'string') {
    if (signedData.includes('op=put&dat=')) {
      // Formato URL encoded
      const match = signedData.match(/dat=([^&]+)/);
      if (match) {
        signedData = decodeURIComponent(match[1]);
      }
    }
    
    if (signedData.startsWith('SAF_')) {
      // Error de AutoFirma
      session.status = 'error';
      session.error = signedData;
      console.error("Error de AutoFirma:", signedData);
    } else {
      // Archivo firmado recibido
      session.signedFile = Buffer.from(signedData, 'base64');
      session.status = 'signed';
      console.log("✓ Archivo firmado recibido correctamente");
    }
  }
  
  res.send("OK");
});

// Verificar estado de la sesión
app.get("/afirma/session/:sessionId/status", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  
  if (!session) {
    return res.status(404).json({ error: "Sesión no encontrada" });
  }
  
  res.json({
    status: session.status,
    signed: session.status === 'signed',
    error: session.error || null
  });
});

// Descargar archivo firmado
app.get("/afirma/session/:sessionId/download", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  
  if (!session || !session.signedFile) {
    return res.status(404).send("Archivo firmado no disponible");
  }
  
  const fileName = session.fileName.replace('.pdf', '_firmado.pdf');
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', session.signedFile.length);
  
  res.send(session.signedFile);
  
  console.log(`✓ Archivo firmado descargado: ${fileName}`);
  
  // Limpiar sesión después de descargar
  setTimeout(() => {
    delete sessions[sessionId];
    console.log(`Sesión ${sessionId} eliminada`);
  }, 60000);
});

// Limpiar sesiones antiguas
setInterval(() => {
  const now = Date.now();
  Object.keys(sessions).forEach(sessionId => {
    const session = sessions[sessionId];
    if (now - session.createdAt > 3600000) { // 1 hora
      delete sessions[sessionId];
      console.log(`Sesión antigua eliminada: ${sessionId}`);
    }
  });
}, 1800000); // Cada 30 minutos

// Storage temporal para archivos grandes
const fileStorage = {};

// Pre-almacenar archivo para AutoFirma
app.post("/afirma/prestorage", (req, res) => {
  try {
    const { id, data, fileName } = req.body;
    
    fileStorage[id] = {
      originalData: data,
      fileName: fileName,
      status: 'pending',
      timestamp: Date.now()
    };
    
    console.log(`Archivo pre-almacenado: ${id} - ${fileName}`);
    res.json({ storageId: id });
  } catch (err) {
    console.error("Error en prestorage:", err);
    res.status(500).json({ error: "Error al almacenar archivo" });
  }
});

// AutoFirma obtiene el archivo original
app.get("/afirma/getstorage/:id", (req, res) => {
  const id = req.params.id;
  console.log(`\n=== AUTOFIRMA SOLICITANDO ARCHIVO ===`);
  console.log(`ID: ${id}`);
  
  const stored = fileStorage[id];
  if (!stored || !stored.originalData) {
    console.error("Archivo no encontrado");
    return res.status(404).send("Archivo no encontrado");
  }
  
  const pdfBuffer = Buffer.from(stored.originalData, 'base64');
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${stored.fileName}"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  
  res.end(pdfBuffer);
  console.log(`✓ PDF enviado a AutoFirma: ${pdfBuffer.length} bytes`);
});

// AutoFirma envía el archivo firmado
app.post("/afirma/poststorage/:id", express.text({ type: '*/*' }), (req, res) => {
  const id = req.params.id;
  console.log(`\n=== AUTOFIRMA ENVIANDO FIRMA ===`);
  console.log(`ID: ${id}`);
  
  if (!fileStorage[id]) {
    return res.status(404).send("Sesión no encontrada");
  }
  
  const body = req.body;
  
  if (typeof body === 'string' && body.length > 0) {
    if (body.startsWith('SAF_')) {
      fileStorage[id].status = 'error';
      fileStorage[id].error = body;
      console.error("Error de AutoFirma:", body);
    } else {
      fileStorage[id].status = 'completed';
      fileStorage[id].signedData = body;
      console.log("✓ Firma recibida correctamente");
    }
  }
  
  res.send("OK");
});

// Verificar estado
app.get("/afirma/checkstorage/:id", (req, res) => {
  const id = req.params.id;
  const stored = fileStorage[id];
  
  if (!stored) {
    return res.json({ status: 'not_found' });
  }
  
  res.json({
    status: stored.status,
    message: stored.error || null
  });
});

// Descargar archivo firmado
app.get("/afirma/downloadstorage/:id", (req, res) => {
  const id = req.params.id;
  const stored = fileStorage[id];
  
  if (!stored || !stored.signedData) {
    return res.status(404).json({ error: "No hay archivo firmado" });
  }
  
  const pdfBuffer = Buffer.from(stored.signedData, 'base64');
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${stored.fileName.replace('.pdf', '_firmado.pdf')}"`);
  res.send(pdfBuffer);
  
  // Limpiar después
  setTimeout(() => delete fileStorage[id], 10000);
});

// Limpiar storage antiguo cada 30 minutos
setInterval(() => {
  const now = Date.now();
  Object.keys(fileStorage).forEach(id => {
    if (now - fileStorage[id].timestamp > 30 * 60 * 1000) {
      delete fileStorage[id];
      console.log(`Storage limpiado: ${id}`);
    }
  });
}, 30 * 60 * 1000);

// Preparar servlet para AutoFirma
app.post("/prepare-servlet", (req, res) => {
  try {
    const { data, fileName } = req.body;
    const timestamp = Date.now();
    const servletId = `servlet_${timestamp}`;
    
    // Guardar los datos en memoria para el servlet
    signatures[servletId] = {
      status: 'pending',
      originalData: data,
      fileName: fileName,
      timestamp: timestamp
    };
    
    console.log(`Servlet preparado - ID: ${servletId}, Archivo: ${fileName}`);
    
    res.json({ servletId });
  } catch (err) {
    console.error("Error al preparar servlet:", err);
    res.status(500).json({ error: "Error al preparar servlet" });
  }
});

// Servlet unificado para AutoFirma
app.all("/afirma/servlet", (req, res) => {
  const op = req.query.op || req.body.op;
  const id = req.query.id || req.body.id;
  
  console.log(`\n=== SERVLET AUTOFIRMA ===`);
  console.log(`Operación: ${op}, ID: ${id}`);
  console.log(`Método: ${req.method}`);
  console.log(`Headers:`, req.headers);
  
  if (!id) {
    return res.status(400).send("ID requerido");
  }
  
  const signatureData = signatures[id];
  if (!signatureData && op !== 'put') {
    return res.status(404).send("Sesión no encontrada");
  }

  switch (op) {
    case 'get':
      // AutoFirma solicita el PDF original
      console.log("AutoFirma solicitando PDF original");
      
      if (!signatureData.originalData) {
        return res.status(404).send("Archivo no encontrado");
      }
      
      const pdfBuffer = Buffer.from(signatureData.originalData, 'base64');
      
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${signatureData.fileName}"`);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.setHeader("Cache-Control", "no-cache");
      
      res.end(pdfBuffer);
      console.log(`✓ PDF enviado a AutoFirma: ${pdfBuffer.length} bytes`);
      break;

    case 'put':
      // AutoFirma envía el PDF firmado
      console.log("Recibiendo PDF firmado de AutoFirma");
      
      if (!signatures[id]) {
        signatures[id] = { status: 'pending' };
      }
      
      let signedData = '';
      
      if (req.method === 'POST') {
        // Manejar diferentes formatos de datos
        if (typeof req.body === 'string') {
          if (req.body.includes('dat=')) {
            const params = new URLSearchParams(req.body);
            signedData = params.get('dat') || '';
          } else {
            signedData = req.body;
          }
        } else if (req.body.dat) {
          signedData = req.body.dat;
        }
      } else if (req.method === 'GET' && req.query.dat) {
        signedData = req.query.dat;
      }
      
      if (signedData) {
        if (signedData.startsWith('SAF_')) {
          signatures[id].status = 'error';
          signatures[id].error = decodeURIComponent(signedData);
          console.error("Error de AutoFirma:", signatures[id].error);
        } else {
          signatures[id].status = 'completed';
          signatures[id].signedData = signedData;
          console.log("✓ Firma recibida correctamente");
        }
      }
      
      res.send("OK");
      break;

    case 'retrieve':
      // AutoFirma verifica si hay datos firmados
      console.log("AutoFirma verificando datos firmados");
      
      if (signatureData.signedData) {
        res.send(signatureData.signedData);
      } else {
        res.status(404).send("No hay datos firmados");
      }
      break;

    case 'status':
      // Cliente web verifica el estado
      res.json({
        status: signatureData.status || 'pending',
        hasSignedData: !!signatureData.signedData,
        message: signatureData.error || null
      });
      break;

    case 'download':
      // Cliente web descarga el PDF firmado
      if (!signatureData.signedData) {
        return res.status(404).json({ error: "No hay archivo firmado" });
      }
      
      const signedPdfBuffer = Buffer.from(signatureData.signedData, 'base64');
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${signatureData.fileName.replace('.pdf', '_firmado.pdf')}"`);
      res.send(signedPdfBuffer);
      
      // Limpiar después de descargar
      setTimeout(() => delete signatures[id], 10000);
      break;

    default:
      res.status(400).send("Operación no válida");
  }
});

// Servir el PDF original para AutoFirma (ruta específica para descarga)
app.get("/afirma/download-original/:id", (req, res) => {
  const id = req.params.id;
  
  console.log(`\n=== AUTOFIRMA DESCARGANDO PDF ORIGINAL ===`);
  console.log(`ID: ${id}`);
  console.log(`User-Agent: ${req.headers['user-agent']}`);
  
  if (!signatures[id]) {
    console.error(`No se encontró archivo para ID: ${id}`);
    return res.status(404).send("Archivo no encontrado");
  }
  
  const signatureData = signatures[id];
  const filePath = signatureData.filePath;
  
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`Archivo no existe: ${filePath}`);
    return res.status(404).send("Archivo no encontrado");
  }

  try {
    const fileContent = fs.readFileSync(filePath);
    
    console.log(`✓ Enviando PDF original: ${signatureData.fileName}`);
    console.log(`  Tamaño: ${(fileContent.length / 1024).toFixed(2)} KB`);
    
    // Headers específicos para AutoFirma
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${signatureData.fileName}"`);
    res.setHeader("Content-Length", fileContent.length);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    
    res.end(fileContent);
    
    console.log(`✓ PDF enviado exitosamente a AutoFirma`);
  } catch (err) {
    console.error(`Error al servir PDF:`, err);
    res.status(500).send("Error al leer archivo");
  }
});

// Servir el PDF para AutoFirma - Con bypass de ngrok
app.all("/pdf/:id", (req, res) => {
  const id = req.params.id;
  
  console.log(`\n=== SOLICITUD DE PDF ===`);
  console.log(`ID solicitado: ${id}`);
  console.log(`Método: ${req.method}`);
  console.log(`Query params:`, req.query);
  
  // Si es una solicitud OPTIONS (preflight), responder OK
  if (req.method === 'OPTIONS') {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "*");
    return res.status(200).send();
  }
  
  // Verificar si el ID existe
  if (!signatures[id]) {
    console.error(`ERROR: No se encontró información para ID: ${id}`);
    console.log("IDs disponibles:", Object.keys(signatures));
    return res.status(404).send("Archivo no encontrado - ID no existe");
  }
  
  const signatureData = signatures[id];
  const filePath = signatureData.filePath;
  
  // Verificar si el archivo existe
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`ERROR: El archivo no existe en: ${filePath}`);
    return res.status(404).send("Archivo no encontrado - Archivo no existe en el servidor");
  }

  try {
    const stats = fs.statSync(filePath);
    const fileContent = fs.readFileSync(filePath);
    
    console.log(`✓ Sirviendo archivo: ${filePath}`);
    console.log(`  Tamaño: ${(stats.size / 1024).toFixed(2)} KB`);
    
    // Headers para bypasear ngrok y servir el PDF correctamente
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Disposition", `attachment; filename="${signatureData.fileName}"`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("ngrok-skip-browser-warning", "69420");
    res.setHeader("Cache-Control", "private, max-age=0");
    
    // Enviar el archivo
    res.end(fileContent);
    
    console.log(`✓ PDF enviado exitosamente para ID: ${id}`);
  } catch (err) {
    console.error(`ERROR al servir PDF:`, err);
    res.status(500).send("Error interno del servidor");
  }
});

// Recibir datos firmados de AutoFirma
app.post("/afirma/storage/:id", (req, res) => {
  const id = req.params.id;
  const body = req.body;
  
  console.log(`\n=== RECIBIENDO DATOS DE AUTOFIRMA ===`);
  console.log(`ID: ${id}`);
  console.log(`Tipo de body: ${typeof body}`);
  console.log(`Contenido (primeros 100 chars): ${JSON.stringify(body).substring(0, 100)}...`);
  
  if (!signatures[id]) {
    console.error(`No existe registro para ID: ${id}`);
    return res.status(404).send("ID no encontrado");
  }

  try {
    let signedData = null;
    let errorMsg = null;

    // AutoFirma puede enviar los datos de varias formas
    if (typeof body === 'string') {
      if (body.includes('op=put')) {
        // Formato URL encoded
        const params = new URLSearchParams(body);
        const dat = params.get('dat');
        
        if (dat) {
          if (dat.startsWith('SAF_')) {
            // Error de AutoFirma
            errorMsg = decodeURIComponent(dat);
            console.error(`Error de AutoFirma: ${errorMsg}`);
          } else {
            // Datos firmados
            signedData = dat;
          }
        }
      } else if (body.length > 100) {
        // Probablemente base64 directo
        signedData = body;
      }
    } else if (body && typeof body === 'object') {
      // Objeto con datos
      if (body.dat) {
        signedData = body.dat;
      } else if (body.data) {
        signedData = body.data;
      }
    }

    if (signedData) {
      signatures[id].status = 'completed';
      signatures[id].signedData = signedData;
      console.log(`✓ Firma completada para ID: ${id}`);
      console.log(`  Tamaño de datos firmados: ${signedData.length} caracteres`);
    } else if (errorMsg) {
      signatures[id].status = 'error';
      signatures[id].error = errorMsg;
    } else {
      console.warn(`⚠ No se pudieron procesar los datos recibidos`);
    }
    
    res.send("OK");
  } catch (err) {
    console.error(`Error al procesar datos de AutoFirma: ${err}`);
    res.status(500).send("Error");
  }
});

// Método GET alternativo para AutoFirma
app.get("/afirma/storage/:id", (req, res) => {
  const id = req.params.id;
  console.log(`\n=== STORAGE GET REQUEST ===`);
  console.log(`ID: ${id}`);
  console.log(`Query params:`, req.query);
  
  if (req.query.op === 'put' && req.query.dat) {
    // AutoFirma está enviando datos
    if (!signatures[id]) {
      signatures[id] = { status: 'pending' };
    }
    
    const dat = req.query.dat;
    if (dat.startsWith('SAF_')) {
      signatures[id].status = 'error';
      signatures[id].error = decodeURIComponent(dat);
    } else {
      signatures[id].status = 'completed';
      signatures[id].signedData = dat;
      console.log(`✓ Firma recibida por GET para ID: ${id}`);
    }
  }
  
  res.send("OK");
});

// Verificar estado de la firma
app.get("/afirma/check/:id", (req, res) => {
  const id = req.params.id;
  const signatureData = signatures[id];
  
  if (!signatureData) {
    return res.json({ status: 'not_found' });
  }
  
  const response = {
    status: signatureData.status,
    message: signatureData.error || null,
    hasSignedData: !!(signatureData.signedData && signatureData.signedData.length > 0)
  };
  
  console.log(`Check status for ${id}:`, response);
  
  res.json(response);
});

// Obtener datos firmados (para AutoFirma)
app.get("/afirma/retrieve/:id", (req, res) => {
  const id = req.params.id;
  const signatureData = signatures[id];
  
  console.log(`\n=== RETRIEVE REQUEST ===`);
  console.log(`ID: ${id}`);
  
  if (!signatureData || !signatureData.signedData) {
    console.log("No hay datos firmados disponibles");
    return res.status(404).send("No encontrado");
  }
  
  console.log(`Enviando datos firmados (${signatureData.signedData.length} chars)`);
  res.send(signatureData.signedData);
});

// Descargar archivo firmado
app.get("/afirma/download/:id", (req, res) => {
  const id = req.params.id;
  const signatureData = signatures[id];
  
  console.log(`\n=== DOWNLOAD REQUEST ===`);
  console.log(`ID: ${id}`);
  
  if (!signatureData) {
    console.error("No se encontró información de firma");
    return res.status(404).json({ error: "Firma no encontrada" });
  }
  
  if (signatureData.status !== 'completed') {
    console.error(`Estado incorrecto: ${signatureData.status}`);
    return res.status(400).json({ error: "La firma no se ha completado" });
  }
  
  if (!signatureData.signedData) {
    console.error("No hay datos firmados");
    return res.status(404).json({ error: "No hay datos firmados disponibles" });
  }
  
  try {
    // Decodificar el PDF firmado
    const pdfBuffer = Buffer.from(signatureData.signedData, 'base64');
    
    if (pdfBuffer.length === 0) {
      throw new Error("El buffer del PDF está vacío");
    }
    
    console.log(`✓ Enviando PDF firmado: ${signatureData.fileName} (${(pdfBuffer.length / 1024).toFixed(2)} KB)`);
    
    const fileName = signatureData.fileName.replace('.pdf', '_firmado.pdf');
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
    
    // Limpiar después de un tiempo
    setTimeout(() => {
      if (signatureData.filePath && fs.existsSync(signatureData.filePath)) {
        fs.unlinkSync(signatureData.filePath);
        console.log(`Archivo temporal eliminado: ${signatureData.filePath}`);
      }
      delete signatures[id];
    }, 10000);
  } catch (err) {
    console.error(`Error al procesar PDF firmado: ${err}`);
    res.status(500).json({ error: "Error al procesar el archivo firmado" });
  }
});

// Ruta de prueba para verificar que el servidor funciona
app.get("/test", (req, res) => {
  res.json({ 
    status: "OK", 
    time: new Date().toISOString(),
    signatures: Object.keys(signatures).length,
    availableIds: Object.keys(signatures)
  });
});


app.get("/", (req, res) => {

  if (req.query['ngrok-skip-browser-warning']) {
    console.log("Ngrok warning page detectada, redirigiendo...");
  }
  res.send("Servidor AutoFirma funcionando");
});

// clean old signatures every 30 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(signatures).forEach(id => {
    const sig = signatures[id];
    if (sig.timestamp && now - sig.timestamp > 30 * 60 * 1000) {
      if (sig.filePath && fs.existsSync(sig.filePath)) {
        fs.unlinkSync(sig.filePath);
      }
      delete signatures[id];
      console.log(`Limpieza: eliminado ${id}`);
    }
  });
}, 30 * 60 * 1000);

app.listen(port, () => {
  console.log(`\n=== SERVIDOR AUTOFIRMA INICIADO ===`);
  console.log(`Puerto: ${port}`);
  console.log(`URL local: http://localhost:${port}`);
  console.log(`\nAsegúrate de:`);
  console.log(`1. Ngrok está ejecutándose: ngrok http ${port}`);
  console.log(`2. La URL de ngrok está actualizada en index.html`);
  console.log(`3. AutoFirma está instalado correctamente`);
  console.log(`=====================================\n`);
});