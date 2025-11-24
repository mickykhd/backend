import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import mongoose from 'mongoose';
import DashboardMapping from './models/DashboardMapping.js';

dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 8989;
const METABASE_URL = "https://analytics.soffront.com";

const CONFIG_MAP = {
  Sales: { templateId: 71, folderId: 17 },
  Marketing: { templateId: 176, folderId: 20 },
  Operations: { templateId: 106, folderId: 19 },
};

const API_HEADERS = {
  "x-api-key": process.env.METABASE_API_KEY,
  "Content-Type": "application/json"
};

// --- Database & Server Init ---
const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI, { dbName: 'CRUD_DB' })
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => { console.error('❌ DB Error:', err); process.exit(1); });

// --- Helper Functions ---

/** 1. Create Collection (Folder) - MOVED TO TOP */
const createCollection = async (projectId, parentFolderId) => {
  try {
    const { data } = await axios.post(
      `${METABASE_URL}/api/collection`,
      {
        name: `${projectId}`,
        description: `Dashboard collection for project ${projectId}`,
        parent_id: parentFolderId,
        color: "#509EE3"
      },
      { headers: API_HEADERS }
    );
    return data.id;
  } catch (error) {
    console.error("Error creating collection:", error.response?.data || error.message);
    throw error;
  }
};

/** 2. Provision Dashboard (Create Folder First -> Then Copy Content Into It) */
const provisionDashboard = async (projectId, moduleName) => {
  const config = CONFIG_MAP[moduleName];
  if (!config) throw new Error(`Invalid module: ${moduleName}`);

  console.log(`⚙️ Provisioning ${moduleName} for Project ${projectId}...`);

  // STEP 1: Create the Tenant Folder first
  const newCollectionId = await createCollection(projectId, config.folderId);
  console.log(`✅ Folder Created: ${newCollectionId}`);

  // STEP 2: Duplicate Template directly INTO the new folder
  // By passing 'collection_id', Metabase puts the Dash AND Questions inside it.
  const { data: copyData } = await axios.post(
    `${METABASE_URL}/api/dashboard/${config.templateId}/copy`,
    {
      name: `Tenant ${projectId} - ${moduleName}`,
      description: `Generated dashboard for ${projectId}`,
      is_deep_copy: true,
      collection_id: newCollectionId // <--- CRITICAL FIX HERE
    },
    { headers: API_HEADERS }
  );

  const newDashboardId = copyData.id;
  console.log(`✅ Dashboard ${newDashboardId} created inside Folder ${newCollectionId}`);

  return newDashboardId;
};

/** Retrieves ID from DB or creates a new dashboard if missing */
const resolveDashboardId = async (projectId, moduleName) => {
  const pid = Number(projectId);
  if (isNaN(pid)) throw new Error("Invalid Project ID");

  // Check DB
  const mapping = await DashboardMapping.findOne({ projectId: pid });
  if (mapping?.dashboardId?.[moduleName]) return mapping.dashboardId[moduleName];

  // Provision if missing
  const newId = await provisionDashboard(pid, moduleName);

  await DashboardMapping.findOneAndUpdate(
    { projectId: pid },
    { $set: { [`dashboardId.${moduleName}`]: newId } },
    { upsert: true, new: true }
  );

  return newId;
};

/** Generates Metabase JWT */
const signToken = (projectId, email_id, user) => {
  const payload = {
    email: email_id,
    first_name: user.first_name || "User",
    last_name: user.last_name || "Soffront",
    groups: ["All Users"],
    project_id: projectId,
    email_id
  };
  return jwt.sign(payload, process.env.METABASE_SECRET, { expiresIn: '24h' });
};

// --- Routes ---

// 1. Get Dashboard ID
app.post("/api/dashboard-id", async (req, res) => {
  try {
    const moduleName = req.body.module_name || req.body.dashboard_type || 'Management';
    const dashboardId = await resolveDashboardId(req.body.project_id, moduleName);
    res.json({ dashboardId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2. SSO / JWT Generation
app.post("/sso/metabase", async (req, res) => {
  try {
    const { project_id, module_name, dashboard_type, email_id, ...userData } = req.body;
    const moduleToUse = module_name || dashboard_type || 'Management';

    const dashboardId = await resolveDashboardId(project_id, moduleToUse);
    const token = signToken(project_id, email_id, userData);

    res.json({ jwt: token, dashboardId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Get All Mappings
app.get("/api/dashboard-mapping", async (req, res) => {
  try {
    const mappings = await DashboardMapping.find({}).sort({ createdAt: -1 });
    const mapObj = mappings.reduce((acc, m) => ({ ...acc, [m.projectId]: m.dashboardId }), {});
    res.json({ count: mappings.length, mapping: mapObj, details: mappings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Delete Mapping
app.delete("/api/dashboard-mapping/:projectId", async (req, res) => {
  try {
    const result = await DashboardMapping.findOneAndDelete({ projectId: Number(req.params.projectId) });
    result ? res.json({ message: "Deleted", result }) : res.status(404).json({ error: "Not Found" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Health Check
app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    dbState: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    count: await DashboardMapping.countDocuments()
  });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  process.exit(0);
});