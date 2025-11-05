import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
// import pool from './database.js';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// (async () => {
//     try {
//         await pool.query('SELECT 1 + 1 AS solution');
//         console.log('Connected to MySQL database');
//     } catch (err) {
//         console.error('Error connecting to MySQL:', err);
//     }
// })();

app.post("/", async (req, res) => {
  
  res.json({ res: "working" });
});


app.post("/sso/metabase", async (req, res) => {
  const projectId = 7353;
  console.log(req.body);
  const token = jwt.sign(
    { 
      email: "user@soffront.com",       
      first_name: "Ashrumochan",  
      last_name: "Badajena",
      groups: ["All Users"],
      project_id: req.body.project_id
    },  
    process.env.METABASE_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ jwt: token });
});





const PORT = process.env.PORT || 8989;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});



