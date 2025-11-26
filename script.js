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
  Sales: { templateId: 71 },
  Marketing: { templateId: 176 },
  Operations: { templateId: 106 },
};

const main_folder_id = 162;

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

/** 1. Create or Get Metabase Group for Tenant */
const getOrCreateMetabaseGroup = async (projectId) => {
  const groupName = `Tenant_${projectId}`;
  
  try {
    // Get all groups
    const { data: groups } = await axios.get(
      `${METABASE_URL}/api/permissions/group`,
      { headers: API_HEADERS }
    );
    
    // Check if group exists
    const existingGroup = groups.find(g => g.name === groupName);
    if (existingGroup) {
      console.log(`✅ Found existing group: ${groupName} (ID: ${existingGroup.id})`);
      return existingGroup.id;
    }
    
    // Create new group
    const { data: newGroup } = await axios.post(
      `${METABASE_URL}/api/permissions/group`,
      { name: groupName },
      { headers: API_HEADERS }
    );
    
    console.log(`✅ Created new group: ${groupName} (ID: ${newGroup.id})`);
    return newGroup.id;
  } catch (error) {
    console.error("Error managing group:", error.response?.data || error.message);
    throw error;
  }
};

/** 2. Set Collection Permissions for Group */
const setCollectionPermissions = async (collectionId, groupId) => {
  try {
    // Get current permission graph
    const { data: permGraph } = await axios.get(
      `${METABASE_URL}/api/collection/graph`,
      { headers: API_HEADERS }
    );
    
    // Update permissions for this collection
    // Grant "write" (Curate) access to the tenant group
    if (!permGraph.groups[groupId]) {
      permGraph.groups[groupId] = {};
    }
    permGraph.groups[groupId][collectionId] = "write";
    
    // Remove "All Users" access to this collection (important for isolation)
    const allUsersGroupId = permGraph.groups["1"] ? "1" : 
                           Object.keys(permGraph.groups).find(id => 
                             permGraph.groups[id].name === "All Users"
                           );
    
    if (allUsersGroupId && permGraph.groups[allUsersGroupId]) {
      permGraph.groups[allUsersGroupId][collectionId] = "none";
    }
    
    // Apply updated permissions
    await axios.put(
      `${METABASE_URL}/api/collection/graph`,
      { ...permGraph },
      { headers: API_HEADERS }
    );
    
    console.log(`✅ Set permissions for collection ${collectionId}, group ${groupId}`);
  } catch (error) {
    console.error("Error setting permissions:", error.response?.data || error.message);
    throw error;
  }
};

/** 3. Get or Create Project Folder */
const getOrCreateProjectFolder = async (projectId) => {
  const pid = Number(projectId);
  
  // Check if folder already exists in DB
  const mapping = await DashboardMapping.findOne({ projectId: pid });
  
  if (mapping?.folderId) {
    console.log(`✅ Reusing existing folder ${mapping.folderId} for Project ${pid}`);
    return { folderId: mapping.folderId, groupId: mapping.groupId };
  }
  
  try {
    // Step 1: Create Metabase group for this tenant
    const groupId = await getOrCreateMetabaseGroup(projectId);
    
    // Step 2: Create folder
    const { data } = await axios.post(
      `${METABASE_URL}/api/collection`,
      {
        name: `Project ${projectId}`,
        description: `Dashboard collection for project ${projectId}`,
        parent_id: main_folder_id,
        color: "#509EE3"
      },
      { headers: API_HEADERS }
    );
    
    const newFolderId = data.id;
    console.log(`✅ Created new folder ${newFolderId} for Project ${pid}`);
    
    // Step 3: Set permissions - only this tenant's group can access
    await setCollectionPermissions(newFolderId, groupId);
    
    // Step 4: Store in database
    await DashboardMapping.findOneAndUpdate(
      { projectId: pid },
      { 
        $set: { 
          folderId: newFolderId,
          groupId: groupId,
          updatedAt: new Date()
        },
        $setOnInsert: { 
          dashboardId: {},
          createdAt: new Date()
        }
      },
      { upsert: true, new: true }
    );
    
    return { folderId: newFolderId, groupId };
  } catch (error) {
    console.error("Error creating collection:", error.response?.data || error.message);
    throw error;
  }
};

/** 4. Provision Dashboard (Copy Template into Project Folder) */
const provisionDashboard = async (projectId, moduleName) => {
  const config = CONFIG_MAP[moduleName];
  if (!config) throw new Error(`Invalid module: ${moduleName}`);

  console.log(`⚙️ Provisioning ${moduleName} for Project ${projectId}...`);

  // Get or create the project folder (and group)
  const { folderId: projectFolderId } = await getOrCreateProjectFolder(projectId);

  // Duplicate Template INTO the project folder
  const { data: copyData } = await axios.post(
    `${METABASE_URL}/api/dashboard/${config.templateId}/copy`,
    {
      name: `${moduleName} Dashboard`,
      description: `${moduleName} dashboard for Project ${projectId}`,
      is_deep_copy: true,
      collection_id: projectFolderId
    },
    { headers: API_HEADERS }
  );

  const newDashboardId = copyData.id;
  console.log(`✅ Dashboard ${newDashboardId} (${moduleName}) created in Folder ${projectFolderId}`);

  return newDashboardId;
};

/** 5. Retrieve Dashboard ID from DB or Create New */
const resolveDashboardId = async (projectId, moduleName) => {
  const pid = Number(projectId);
  if (isNaN(pid)) throw new Error("Invalid Project ID");

  // Check if dashboard exists in DB
  const mapping = await DashboardMapping.findOne({ projectId: pid });
  if (mapping?.dashboardId?.[moduleName]) {
    console.log(`✅ Found existing ${moduleName} dashboard: ${mapping.dashboardId[moduleName]}`);
    return mapping.dashboardId[moduleName];
  }

  // Create new dashboard if missing
  const newDashboardId = await provisionDashboard(pid, moduleName);

  // Store dashboard ID in DB
  await DashboardMapping.findOneAndUpdate(
    { projectId: pid },
    { 
      $set: { 
        [`dashboardId.${moduleName}`]: newDashboardId,
        updatedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );

  return newDashboardId;
};

/** 6. Generate Metabase JWT with Tenant-Specific Group */
const signToken = (projectId, email_id, user) => {
  const tenantGroup = `Tenant_${projectId}`; // Must match group name in Metabase

  const payload = {
    email: email_id,
    first_name: user.first_name || "User",
    last_name: user.last_name || "Soffront",
    groups: [tenantGroup], // This maps to Metabase group
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
    res.json({ 
      count: mappings.length, 
      mappings: mappings.map(m => ({
        projectId: m.projectId,
        folderId: m.folderId,
        groupId: m.groupId,
        dashboards: m.dashboardId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Delete Mapping
app.delete("/api/dashboard-mapping/:projectId", async (req, res) => {
  try {
    const mapping = await DashboardMapping.findOne({ projectId: Number(req.params.projectId) });
    
    if (!mapping) {
      return res.status(404).json({ error: "Project Not Found" });
    }
    
    // Optional: Delete collection and group from Metabase
    // await axios.delete(`${METABASE_URL}/api/collection/${mapping.folderId}`, { headers: API_HEADERS });
    // await axios.delete(`${METABASE_URL}/api/permissions/group/${mapping.groupId}`, { headers: API_HEADERS });
    
    await DashboardMapping.findOneAndDelete({ projectId: Number(req.params.projectId) });
    res.json({ message: "Deleted successfully", projectId: req.params.projectId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Health Check
app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    dbState: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    projectsCount: await DashboardMapping.countDocuments()
  });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  process.exit(0);
});
