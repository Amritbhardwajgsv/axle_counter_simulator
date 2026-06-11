import axios from "axios";

const URL = "https://axle-counter-simulator.onrender.com/health";

async function hitServer() {
  try {
    const response = await axios.get(URL, {
      timeout: 10000,
    });

    console.log(
      `[${new Date().toISOString()}] Status: ${response.status}`
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error:`,
      error.message
    );
  }
}

// Run immediately
hitServer();

// Run every 3 minutes
setInterval(hitServer, 3 * 60 * 1000);
