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
    - Select one connection as master per airport to take only his position data
        - how to transfer ownership dynamically
        - does it reduce transfer rate ? if no just don't
        - how to determine master ? First in ?
    - take all positions data and compile
        - seemless transitions
        - high transfer rate ?



