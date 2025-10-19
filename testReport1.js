import fetch from "node-fetch";

const response = await fetch("http://localhost:3000/api/airports/LFPG/stands", {
  method: "GET",
  headers: { "Content-Type": "application/json" },
});

console.log("Status:", response.status);
console.log("Content-Type:", response.headers.get("content-type"));

if (!response.ok) {
  const text = await response.text();
  console.error("Error response:", text);
  throw new Error(`HTTP error! status: ${response.status}`);
}

const contentType = response.headers.get("content-type");
if (!contentType || !contentType.includes("application/json")) {
  const text = await response.text();
  console.error("Non-JSON response:", text);
  throw new Error("Response is not JSON");
}

const data = await response.json();
console.log("Number of stands at LFPG:", Object.keys(data).length);
console.log("Stands at LFPG:", data);