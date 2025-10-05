# Ramp Agent

## Requirements
- Track occupied/blocked stands
    - Detection by position
    - assigned stand memory
- Store airports config
- Assign stands
    - based on position report
    - when requested by client (recycle)
    - when assigned via menu from client

- Debug interface
    - map showing occupied/blocked stands
    - log on website
    - Airport info screen layout ?
    - Stats report (# of assigned stands, # of requests, # of custom assigns)

- Be Fast as fuck boys

- limit request rate



## Structure

- Position data reception (multiple ATC connected) what rate ? Event based ?
    - Select connections as masters per airport to take only their position data
        - how to transfer ownership dynamically
        - does it reduce transfer rate ? if no just don't
        - how to determine master ? First in ?
    - take all positions data and compile
        - seemless transitions
        - high transfer rate ?

    client side now which one are masters and send or not the reports → server side process all reports because only masters are sending one
    yes but since developping for neoRadar & Euroscope, both plugins will need bespoke implementations and can desync
    server side would be better but how to select ?
    

- Client report :
    - JSON of aircraft that are stopped, on ground of concerned airport (FP active or not)
    - \+ all converned airborn aircraft < maxAlt && < maxDist


| Folder             | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| **`index.js`**     | Starts Express and registers all routes.                                   |
| **`config/`**      | Stores configuration constants (port, update interval, etc.).              |
| **`routes/`**      | Each file declares the API endpoints (`/report`, `/assign`, etc.).         |
| **`controllers/`** | Handles the request/response logic (validations, data formatting).         |
| **`services/`**    | Contains business logic — your C++ call, occupancy tracking, merging, etc. |
| **`native/`**      | Where you’ll put and compile your `.cpp` → `.node` addon later.            |
| **`utils/`**       | Logging, error handling, helpers.                                          |
