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
const METABASE_URL = 'https://analytics.soffront.com';

const CONFIG_MAP = {
  Sales: { templateId: 71 },
  Marketing: { templateId: 176 },
  Operations: { templateId: 106 },
};

const main_folder_id = 162;
const TEMPLATE_GROUP_ID = 269;

const API_HEADERS = {
  'x-api-key': process.env.METABASE_API_KEY,
  'Content-Type': 'application/json',
};

// --- Database & Server Init ---
const app = express();
app.use(cors());
app.use(express.json());

mongoose
  .connect(process.env.MONGODB_URI, { dbName: 'CRUD_DB' })
  .then(() => console.log('✅ MongoDB Connected'))
  .catch((err) => {
    console.error('❌ DB Error:', err);
    process.exit(1);
  });

// --- Helper Functions ---

/**
 * Clone sandboxing (GTAP) rules from template group to target group
 */
const cloneSandboxingRules = async (targetGroupId) => {
  try {
    // Get all sandbox rules for the template group
    const { data: allGtaps } = await axios.get(
      `${METABASE_URL}/api/mt/gtap`,
      { headers: API_HEADERS }
    );

    const templateGtaps = allGtaps.filter(
      (gtap) => gtap.group_id === TEMPLATE_GROUP_ID
    );

    if (templateGtaps.length === 0) {
      console.log('ℹ️ No sandboxing rules found in template group');
      return;
    }

    console.log(
      `📋 Found ${templateGtaps.length} sandboxing rules to clone`
    );

    // Delete any existing GTAP rules for target group (to avoid duplicates)
    const targetGtaps = allGtaps.filter(
      (gtap) => gtap.group_id === targetGroupId
    );
    
    for (const gtap of targetGtaps) {
      await axios.delete(
        `${METABASE_URL}/api/mt/gtap/${gtap.id}`,
        { headers: API_HEADERS }
      );
    }

    // Clone each GTAP rule from template to target
    for (const templateGtap of templateGtaps) {
      const newGtap = {
        group_id: targetGroupId,
        table_id: templateGtap.table_id,
        card_id: templateGtap.card_id,
        attribute_remappings: templateGtap.attribute_remappings,
      };

      await axios.post(
        `${METABASE_URL}/api/mt/gtap`,
        newGtap,
        { headers: API_HEADERS }
      );

      console.log(
        `  ✅ Cloned sandbox for table ${templateGtap.table_id}`
      );
    }

    console.log(
      `✅ Cloned ${templateGtaps.length} sandboxing rules to group ${targetGroupId}`
    );
  } catch (error) {
    console.error(
      '❌ Error cloning sandbox rules:',
      error.response?.data || error.message
    );
    // Don't throw - sandboxing is optional
  }
};

/**
 * Clone data permissions from template group
 */
const cloneDataPermissionsFromTemplate = async (targetGroupId) => {
  try {
    const { data: permGraph } = await axios.get(
      `${METABASE_URL}/api/permissions/graph`,
      { headers: API_HEADERS }
    );

    const groups = permGraph.groups || {};
    const templateKey = String(TEMPLATE_GROUP_ID);
    const targetKey = String(targetGroupId);

    const template = groups[templateKey];
    if (!template) {
      console.warn(
        `⚠️ Template group ${templateKey} not found in permissions graph`
      );
      return;
    }

    if (templateKey === targetKey) {
      console.log(`ℹ️ Skipping clone for template group itself`);
      return;
    }

    console.log(`📊 Cloning permissions from group ${templateKey} → ${targetKey}`);

    // Deep clone template permissions
    groups[targetKey] = JSON.parse(JSON.stringify(template));
    permGraph.groups = groups;

    await axios.put(
      `${METABASE_URL}/api/permissions/graph`,
      permGraph,
      { headers: API_HEADERS }
    );

    console.log(`✅ Cloned data permissions from group ${templateKey} → ${targetKey}`);

    // IMPORTANT: Clone sandboxing rules after permissions
    await cloneSandboxingRules(targetGroupId);
    
  } catch (error) {
    console.error(
      '❌ Error cloning data permissions:',
      error.response?.data || error.message
    );
    throw error;
  }
};

/** 1. Create or Get Metabase Group for Tenant */
const getOrCreateMetabaseGroup = async (projectId) => {
  const groupName = `Tenant_${projectId}`;

  try {
    const { data: groups } = await axios.get(
      `${METABASE_URL}/api/permissions/group`,
      { headers: API_HEADERS }
    );

    const existingGroup = groups.find((g) => g.name === groupName);
    if (existingGroup) {
      console.log(
        `✅ Found existing group: ${groupName} (ID: ${existingGroup.id})`
      );
      
      // Clone template permissions for existing groups
      await cloneDataPermissionsFromTemplate(existingGroup.id);
      
      return existingGroup.id;
    }

    // Create new group
    const { data: newGroup } = await axios.post(
      `${METABASE_URL}/api/permissions/group`,
      { name: groupName },
      { headers: API_HEADERS }
    );

    console.log(`✅ Created new group: ${groupName} (ID: ${newGroup.id})`);

    // Clone DB/data/RLS permissions from template
    await cloneDataPermissionsFromTemplate(newGroup.id);

    return newGroup.id;
  } catch (error) {
    console.error(
      '❌ Error managing group:',
      error.response?.data || error.message
    );
    throw error;
  }
};

/** 2. Set Collection Permissions for Group */
const setCollectionPermissions = async (collectionId, groupId) => {
  try {
    const { data: permGraph } = await axios.get(
      `${METABASE_URL}/api/collection/graph`,
      { headers: API_HEADERS }
    );

    if (!permGraph.groups[groupId]) {
      permGraph.groups[groupId] = {};
    }
    permGraph.groups[groupId][collectionId] = 'write';

    const allUsersGroupId =
      permGraph.groups['1']
        ? '1'
        : Object.keys(permGraph.groups).find(
            (id) => permGraph.groups[id].name === 'All Users'
          );

    if (allUsersGroupId && permGraph.groups[allUsersGroupId]) {
      permGraph.groups[allUsersGroupId][collectionId] = 'none';
    }

    await axios.put(
      `${METABASE_URL}/api/collection/graph`,
      permGraph,
      { headers: API_HEADERS }
    );

    console.log(
      `✅ Set collection permissions for collection ${collectionId}, group ${groupId}`
    );
  } catch (error) {
    console.error(
      '❌ Error setting collection permissions:',
      error.response?.data || error.message
    );
    throw error;
  }
};

/** 3. Get or Create Project Folder */
const getOrCreateProjectFolder = async (projectId) => {
  const pid = Number(projectId);

  const mapping = await DashboardMapping.findOne({ projectId: pid });

  if (mapping?.folderId) {
    console.log(
      `✅ Reusing existing folder ${mapping.folderId} for Project ${pid}`
    );
    return { folderId: mapping.folderId, groupId: mapping.groupId };
  }

  try {
    const groupId = await getOrCreateMetabaseGroup(projectId);

    const { data } = await axios.post(
      `${METABASE_URL}/api/collection`,
      {
        name: `Project ${projectId}`,
        description: `Dashboard collection for project ${projectId}`,
        parent_id: main_folder_id,
        color: '#509EE3',
      },
      { headers: API_HEADERS }
    );

    const newFolderId = data.id;
    console.log(`✅ Created new folder ${newFolderId} for Project ${pid}`);

    await setCollectionPermissions(newFolderId, groupId);

    await DashboardMapping.findOneAndUpdate(
      { projectId: pid },
      {
        $set: {
          folderId: newFolderId,
          groupId: groupId,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          dashboardId: {},
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return { folderId: newFolderId, groupId };
  } catch (error) {
    console.error(
      '❌ Error creating collection:',
      error.response?.data || error.message
    );
    throw error;
  }
};

/** 4. Provision Dashboard */
const provisionDashboard = async (projectId, moduleName) => {
  const config = CONFIG_MAP[moduleName];
  if (!config) throw new Error(`Invalid module: ${moduleName}`);

  console.log(`⚙️ Provisioning ${moduleName} for Project ${projectId}...`);

  const { folderId: projectFolderId } = await getOrCreateProjectFolder(
    projectId
  );

  const { data: copyData } = await axios.post(
    `${METABASE_URL}/api/dashboard/${config.templateId}/copy`,
    {
      name: `${moduleName} Dashboard`,
      description: `${moduleName} dashboard for Project ${projectId}`,
      is_deep_copy: true,
      collection_id: projectFolderId,
    },
    { headers: API_HEADERS }
  );

  const newDashboardId = copyData.id;
  console.log(
    `✅ Dashboard ${newDashboardId} (${moduleName}) created in Folder ${projectFolderId}`
  );

  return newDashboardId;
};

/** 5. Retrieve Dashboard ID */
const resolveDashboardId = async (projectId, moduleName) => {
  const pid = Number(projectId);
  if (isNaN(pid)) throw new Error('Invalid Project ID');

  const mapping = await DashboardMapping.findOne({ projectId: pid });
  if (mapping?.dashboardId?.[moduleName]) {
    console.log(
      `✅ Found existing ${moduleName} dashboard: ${mapping.dashboardId[moduleName]}`
    );
    return mapping.dashboardId[moduleName];
  }

  const newDashboardId = await provisionDashboard(pid, moduleName);

  await DashboardMapping.findOneAndUpdate(
    { projectId: pid },
    {
      $set: {
        [`dashboardId.${moduleName}`]: newDashboardId,
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  return newDashboardId;
};

/** 6. Generate Metabase JWT */
const signToken = (projectId, email_id, user) => {
  const tenantGroup = `Tenant_${projectId}`;

  const payload = {
    email: email_id,
    first_name: user.first_name || 'User',
    last_name: user.last_name || 'Soffront',
    groups: [tenantGroup],
    project_id: projectId,
    email_id,
  };

  return jwt.sign(payload, process.env.METABASE_SECRET, {
    expiresIn: '24h',
  });
};

// --- Routes ---

app.post('/api/dashboard-id', async (req, res) => {
  try {
    const moduleName =
      req.body.module_name || req.body.dashboard_type || 'Management';
    const dashboardId = await resolveDashboardId(
      req.body.project_id,
      moduleName
    );
    res.json({ dashboardId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/sso/metabase', async (req, res) => {
  try {
    const { project_id, module_name, dashboard_type, email_id, ...userData } =
      req.body;
    const moduleToUse = module_name || dashboard_type || 'Management';

    const dashboardId = await resolveDashboardId(project_id, moduleToUse);
    const token = signToken(project_id, email_id, userData);

    res.json({ jwt: token, dashboardId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard-mapping', async (req, res) => {
  try {
    const mappings = await DashboardMapping.find({}).sort({ createdAt: -1 });
    res.json({
      count: mappings.length,
      mappings: mappings.map((m) => ({
        projectId: m.projectId,
        folderId: m.folderId,
        groupId: m.groupId,
        dashboards: m.dashboardId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/dashboard-mapping/:projectId', async (req, res) => {
  try {
    const mapping = await DashboardMapping.findOne({
      projectId: Number(req.params.projectId),
    });

    if (!mapping) {
      return res.status(404).json({ error: 'Project Not Found' });
    }

    await DashboardMapping.findOneAndDelete({
      projectId: Number(req.params.projectId),
    });
    res.json({
      message: 'Deleted successfully',
      projectId: req.params.projectId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    dbState:
      mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
    projectsCount: await DashboardMapping.countDocuments(),
  });
});

app.post('/api/debug/clone-permissions/:projectId', async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    console.log(`\n🔍 Manual permission clone triggered for project ${projectId}`);
    
    const groupId = await getOrCreateMetabaseGroup(projectId);
    
    res.json({
      message: 'Permission clone completed',
      projectId,
      groupId,
      note: 'Check server logs and Metabase admin UI'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  process.exit(0);
});

