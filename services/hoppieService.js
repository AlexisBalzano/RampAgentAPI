const { info, warn, error } = require("../utils/logger");

const HOPPIE_URL = "http://www.hoppie.nl/acars/system/connect.html";

async function callHoppie(params) {
  const logon = process.env.HOPPIE_LOGON_CODE;
  const from = process.env.HOPPIE_FROM_STATION;
  if (!logon || !from) {
    warn(
      "HOPPIE_LOGON_CODE or HOPPIE_FROM_STATION not configured, skipping Hoppie request",
      { category: "Hoppie" }
    );
    return null;
  }

  const body = new URLSearchParams({ logon, from, ...params });
  const res = await fetch(HOPPIE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return await res.text();
}

// Confirms a station matching `callsign` is currently connected to Hoppie ACARS.
exports.isConnected = async (callsign) => {
  try {
    const response = await callHoppie({
      to: "SERVER",
      type: "ping",
      packet: callsign,
    });
    if (!response) return false;

    const trimmed = response.trim();
    if (!trimmed.toLowerCase().startsWith("ok")) {
      warn(`Hoppie ping for ${callsign} returned unexpected response: ${trimmed}`, {
        category: "Hoppie",
        callsign,
      });
      return false;
    }

    const match = trimmed.match(/{([^}]*)}/);
    const onlineStations = match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
    return onlineStations.some((s) => s.toUpperCase() === callsign.toUpperCase());
  } catch (err) {
    error(`Hoppie ping request failed for ${callsign}: ${err.message}`, {
      category: "Hoppie",
      callsign,
    });
    return false;
  }
};

// Sends a TELEX message to `callsign`. Returns true if Hoppie accepted the message.
exports.sendTelex = async (callsign, message) => {
  try {
    const response = await callHoppie({
      to: callsign,
      type: "telex",
      packet: message,
    });
    if (!response || !response.trim().toLowerCase().startsWith("ok")) {
      warn(`Hoppie telex to ${callsign} failed: ${response}`, {
        category: "Hoppie",
        callsign,
      });
      return false;
    }
    info(`Hoppie telex sent to ${callsign}`, { category: "Hoppie", callsign });
    return true;
  } catch (err) {
    error(`Hoppie telex request failed for ${callsign}: ${err.message}`, {
      category: "Hoppie",
      callsign,
    });
    return false;
  }
};
