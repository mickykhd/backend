// ==========================================
// COMPLETE BACKEND: Metabase SSO + Auto Dashboard Creation
// MongoDB Version - Replaces in-memory storage
// ==========================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import mongoose from 'mongoose';
import DashboardMapping from './models/DashboardMapping.js';

dotenv.config();

// ========================
// CONFIGURATION
// ========================

const METABASE_URL = "https://analytics.soffront.com";
const METABASE_API_KEY = "mb_7D5li70kINfHbA+sXVnvt5eZaUcdzJByRye2HrJY09E=";
const TEMPLATE_DASHBOARD_ID = process.env.TEMPLATE_DASHBOARD_ID || 95;
const PORT = process.env.PORT || 8989;
const MONGODB_URI = process.env.MONGODB_URI;

// ==========================================
// MONGODB CONNECTION
// ==========================================
const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: 'CRUD_DB'
    });
    
    console.log('✅ MongoDB Atlas Connected Successfully');
    console.log('📊 Database: CRUD_DB');
    console.log('📁 Collection: metabase');
    
    // Initialize default mappings (optional)
    await initializeDefaultMappings();
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    process.exit(1);
  }
};

// Handle connection events
mongoose.connection.on('error', (err) => {
  console.error('❌ Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ Mongoose disconnected');
});

// ==========================================
// INITIALIZE DEFAULT MAPPINGS (Optional)
// ==========================================
async function initializeDefaultMappings() {
  try {
    const defaultMappings = [
     
    ];

    for (const mapping of defaultMappings) {
      await DashboardMapping.findOneAndUpdate(
        { projectId: mapping.projectId },
        mapping,
        { upsert: true, new: true }
      );
    }
    console.log('✅ Default mappings initialized');
  } catch (error) {
    console.error('⚠️ Error initializing mappings:', error.message);
  }
}

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

    const response = await axios.post(
      `${METABASE_URL}/api/dashboard/${TEMPLATE_DASHBOARD_ID}/copy`,
      {
        name: `Tenant ${projectId} Dashboard`,
        description: `Dashboard for tenant ${projectId}`,
        is_deep_copy: true,
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
// FUNCTION 2: Get or Create Dashboard ID (MongoDB Version)
// ==========================================
async function getOrCreateDashboardId(projectId) {
  try {
    // Convert to number
    const projectIdNum = Number(projectId);
    
    if (isNaN(projectIdNum)) {
      throw new Error(`Invalid project_id: ${projectId}`);
    }

    // ✅ Check if mapping exists in MongoDB
    let mapping = await DashboardMapping.findOne({ projectId: projectIdNum });

    if (mapping) {
      console.log(`✅ Dashboard found in DB. Project ${projectIdNum} → ${mapping.dashboardId}`);
      return mapping.dashboardId;
    }

    console.log(`📋 No dashboard for project ${projectIdNum}. Creating one...`);

    if (!METABASE_API_KEY) {
      throw new Error("METABASE_API_KEY not configured in .env");
    }

    // Duplicate the dashboard
    const newDashboardId = await duplicateDashboard(projectIdNum);

    // ✅ Save to MongoDB
    mapping = await DashboardMapping.findOneAndUpdate(
      { projectId: projectIdNum },
      { projectId: projectIdNum, dashboardId: newDashboardId },
      { upsert: true, new: true }
    );

    console.log(`✅ Stored in MongoDB: ${projectIdNum} → ${newDashboardId}\n`);
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
    tenant_id: projectId,
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
// ENDPOINT 3: Get All Mappings (MongoDB Version)
// GET /api/dashboard-mapping
// ==========================================
app.get("/api/dashboard-mapping", async (req, res) => {
  try {
    // ✅ Get all mappings from MongoDB
    const mappings = await DashboardMapping.find({}).sort({ createdAt: -1 });
    
    // Convert to old format for compatibility
    const mappingObject = {};
    mappings.forEach(m => {
      mappingObject[m.projectId] = m.dashboardId;
    });
    
    res.json({ 
      mapping: mappingObject,
      total: mappings.length,
      details: mappings
    });
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT 4: Delete Mapping (New)
// DELETE /api/dashboard-mapping/:projectId
// ==========================================
app.delete("/api/dashboard-mapping/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const projectIdNum = Number(projectId);
    
    if (isNaN(projectIdNum)) {
      return res.status(400).json({ error: "Invalid project_id" });
    }
    
    // ✅ Delete from MongoDB
    const result = await DashboardMapping.findOneAndDelete({ projectId: projectIdNum });
    
    if (!result) {
      return res.status(404).json({ error: "Mapping not found" });
    }
    
    res.json({ 
      message: "Mapping deleted successfully", 
      deleted: result 
    });
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT 5: Health Check
// GET /health
// ==========================================
app.get("/health", async (req, res) => {
  try {
    const count = await DashboardMapping.countDocuments();
    res.json({ 
      status: "ok",
      database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      dashboards: count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: "error",
      error: error.message 
    });
  }
});

// ==========================================
// START SERVER
// ==========================================
const startServer = async () => {
  try {
    await connectDB();
    
    app.listen(PORT, () => {
      console.log("\n==============================================");
      console.log(`🚀 Metabase SSO Server running on port ${PORT}`);
      console.log("\nEndpoints:");
      console.log(" POST   /api/dashboard-id             → Get/Create dashboard");
      console.log(" POST   /sso/metabase                 → Get JWT token");
      console.log(" GET    /api/dashboard-mapping        → View all mappings");
      console.log(" DELETE /api/dashboard-mapping/:id    → Delete mapping");
      console.log(" GET    /health                       → Health check");
      console.log("==============================================\n");
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️ Shutting down gracefully...');
  await mongoose.connection.close();
  console.log('✅ MongoDB connection closed');
  process.exit(0);
});

startServer();


