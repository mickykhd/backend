// ==========================================
// COMPLETE BACKEND: Metabase SSO + Auto Dashboard Creation
// Fixed version that handles dashboard questions
// ==========================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import axios from 'axios';

dotenv.config();

// ========================
// CONFIGURATION
// ========================

const METABASE_URL = "https://analytics.soffront.com";
const METABASE_API_KEY = "mb_7D5li70kINfHbA+sXVnvt5eZaUcdzJByRye2HrJY09E=";
const TEMPLATE_DASHBOARD_ID = process.env.TEMPLATE_DASHBOARD_ID || 16;
const PORT = process.env.PORT || 8989;

// ==========================================
// IN-MEMORY STORAGE
// ==========================================
let dashboardMap = {
  
};

// ==========================================
// EXPRESS SERVER SETUP
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// FUNCTION 1: Duplicate Dashboard via API
// Uses is_deep_copy: true for proper duplication
// ==========================================
async function duplicateDashboard(projectId) {
  try {
    console.log(`\n📋 Duplicating dashboard ${TEMPLATE_DASHBOARD_ID} for project ${projectId}...`);

    // ✅ KEY: Use is_deep_copy: true to duplicate with all questions
    const response = await axios.post(
      `${METABASE_URL}/api/dashboard/${TEMPLATE_DASHBOARD_ID}/copy`,
      {
        name: `Tenant ${projectId} Dashboard`,
        description: `Dashboard for tenant ${projectId}`,
        is_deep_copy: true,  // ✅ CRITICAL: This allows deep copy with questions
      },
      {
        headers: {
          "x-api-key": METABASE_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const newDashboardId = response.data.id;
    console.log(`✅ Dashboard duplicated successfully! New ID: ${newDashboardId}`);
    return newDashboardId;
  } catch (error) {
    console.error("❌ Error duplicating dashboard:", error.message);
    if (error.response?.data) {
      console.error("Response:", error.response.data);
    }
    throw error;
  }
}

// ==========================================
// FUNCTION 2: Get or Create Dashboard ID
// ==========================================
async function getOrCreateDashboardId(projectId) {
  try {
    // Check if already exists
    if (dashboardMap[projectId]) {
      console.log(`✅ Dashboard found in mapping. Project ${projectId} → ${dashboardMap[projectId]}`);
      return dashboardMap[projectId];
    }

    console.log(`📋 No dashboard for project ${projectId}. Creating one...`);

    if (!METABASE_API_KEY) {
      throw new Error("METABASE_API_KEY not configured in .env");
    }

    // ✅ Duplicate the dashboard
    const newDashboardId = await duplicateDashboard(projectId);

    // Store in mapping
    dashboardMap[projectId] = newDashboardId;
    console.log(`✅ Stored: ${projectId} → ${newDashboardId}\n`);

    return newDashboardId;
  } catch (error) {
    console.error("❌ Error in getOrCreateDashboardId:", error.message);
    throw error;
  }
}

// ==========================================
// FUNCTION 3: Generate JWT Token
// ==========================================
function generateMetabaseJWT(projectId, firstName = "User", lastName = "Soffront", email = null) {
  const userEmail = email || `tenant-${projectId}@soffront.com`;

  const payload = {
    email: userEmail,
    first_name: firstName,
    last_name: lastName,
    groups: ["All Users"],
    project_id: projectId,
    tenant_id: projectId,  // For RLS filtering
  };

  return jwt.sign(payload, process.env.METABASE_SECRET, { expiresIn: '24h' });
}

// ==========================================
// ENDPOINT 1: Get Dashboard ID
// POST /api/dashboard-id
// ==========================================
app.post("/api/dashboard-id", async (req, res) => {
  try {
    const { project_id } = req.body;

    if (!project_id) {
      return res.status(400).json({ error: "Missing project_id" });
    }

    console.log(`\n📥 Dashboard request: ${project_id}`);

    const dashboardId = await getOrCreateDashboardId(project_id);
    res.json({ dashboardId });
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT 2: Generate JWT
// POST /sso/metabase
// ==========================================
app.post("/sso/metabase", async (req, res) => {
  try {
    const { project_id, first_name, last_name, email } = req.body;

    if (!project_id) {
      return res.status(400).json({ error: "Missing project_id" });
    }

    console.log(`\n🔐 SSO request: ${project_id}`);

    const dashboardId = await getOrCreateDashboardId(project_id);
    const token = generateMetabaseJWT(project_id, first_name, last_name, email);

    console.log(`✅ JWT generated for dashboard ${dashboardId}`);
    res.json({ jwt: token });
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT 3: Get Mapping
// GET /api/dashboard-mapping
// ==========================================
app.get("/api/dashboard-mapping", (req, res) => {
  res.json({ mapping: dashboardMap });
});

// ==========================================
// ENDPOINT 4: Health Check
// GET /health
// ==========================================
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok",
    dashboards: Object.keys(dashboardMap).length,
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log("\n==============================================");
  console.log(`🚀 Metabase SSO Server running on port ${PORT}`);
  console.log("\nEndpoints:");
  console.log(" POST /api/dashboard-id      → Get/Create dashboard");
  console.log(" POST /sso/metabase          → Get JWT token");
  console.log(" GET  /api/dashboard-mapping → View mapping");
  console.log(" GET  /health                → Health check");
  console.log("==============================================\n");

});

