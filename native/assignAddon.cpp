#include <algorithm>
#include <fstream>
#include <iostream>
#include <vector>
// #include <filesystem>
#include <unordered_set>
// #include "nlohmann/json.hpp"

enum class AircraftType
{
    airliner = 0,
    generalAviation,
    helicopter,
    military,
    cargo
};

struct Pilot
{
    std::string callsign;
    std::string origin;
    std::string destination;
    std::string aircraftCode;
    AircraftType aircraftType;
    std::string stand;
    bool isSchengen;

    bool empty() const
    {
        return callsign.empty();
    }
};

struct Stand
{
    std::string name;
    std::string icao;
    std::string callsign;

    bool operator==(const Stand &other) const
    {
        return name == other.name && icao == other.icao && callsign == other.callsign;
    }
};

std::string assignStands(const std::string &callsign)
{
    std::optional<Pilot> pilotOpt = getPilotByCallsign(callsign);
    if (!pilotOpt)
        return;

    Pilot pilot = *pilotOpt;

    std::vector<std::string> errorMessages;
    errorMessages.reserve(300);

    // Ensure correct config loaded
    std::string icao = toUpperCase(pilot.destination);
    if (!retrieveCorrectConfigJson(icao))
    {
        loggerAPI_->log(Logger::LogLevel::Warning, "Failed to retrieve config when assigning Stand for: " + callsign);
        pilot.stand = "";
        std::lock_guard<std::mutex> lock(dataMutex_);
        updatePilotStand(callsign, pilot.stand);
        return;
    }

    bool needDump = false;

    {
        std::lock_guard<std::mutex> lock(dataMutex_);

        // If aircraft already occupies a stand, reuse it
        auto occupiedIt = std::find_if(occupiedStands_.begin(), occupiedStands_.end(),
                                       [&callsign](const Stand &stand)
                                       { return callsign == stand.callsign; });
        if (occupiedIt != occupiedStands_.end())
        {
            pilot.stand = occupiedIt->name;
            LOG_DEBUG(Logger::LogLevel::Info, "Pilot: " + pilot.callsign + " already occupies stand: " + pilot.stand);
            updatePilotStand(callsign, pilot.stand);
            return;
        }

        nlohmann::json standsJson;
        if (configJson_.contains("Stands"))
        {
            standsJson = configJson_["Stands"];
            LOG_DEBUG(Logger::LogLevel::Info, "Assigning stand for pilot: " + pilot.callsign + " at " + pilot.destination);
        }
        else
        {
            loggerAPI_->log(Logger::LogLevel::Warning, "No STAND section in config for: " + icao);
            pilot.stand = "";
            updatePilotStand(callsign, pilot.stand);
            return;
        }

        errorMessages.push_back("Total stands available before filtering: " + std::to_string(standsJson.size()));

        // Filtering
        auto it = standsJson.begin();
        while (it != standsJson.end())
        {
            const auto &stand = *it;
            // Size Code
            if (stand.contains("Code"))
            {
                std::string code = stand["Code"].get<std::string>();
                if (code.find(pilot.aircraftCode) == std::string::npos)
                {
                    errorMessages.push_back("Removing stand " + it.key() + " due to code mismatch. Stand: " + code + " Pilot: " + pilot.aircraftCode);
                    it = standsJson.erase(it);
                    continue;
                }
            }
            // Use
            if (stand.contains("Use"))
            {
                std::string use = stand["Use"].get<std::string>();
                std::string pilotType;
                switch (pilot.aircraftType)
                {
                case AircraftType::airliner:
                    pilotType = "A";
                    break;
                case AircraftType::generalAviation:
                    pilotType = "P";
                    break;
                case AircraftType::helicopter:
                    pilotType = "H";
                    break;
                case AircraftType::military:
                    pilotType = "M";
                    break;
                case AircraftType::cargo:
                    pilotType = "C";
                    break;
                default:
                    pilotType = "";
                    break;
                }
                if (use.find(pilotType) == std::string::npos)
                {
                    errorMessages.push_back("Removing stand " + it.key() + " due to Use mismatch. Stand: " + use + " Pilot: " + pilotType);
                    it = standsJson.erase(it);
                    continue;
                }
            }
            // Schengen
            if (stand.contains("Schengen"))
            {
                bool schegen = stand["Schengen"].get<bool>();
                if (schegen != pilot.isSchengen)
                {
                    errorMessages.push_back("Removing stand " + it.key() + " due to Schengen mismatch. Stand: " + (schegen ? "true" : "false") + " Pilot: " + (pilot.isSchengen ? "true" : "false"));
                    it = standsJson.erase(it);
                    continue;
                }
            }
            // Countries
            if (stand.contains("Countries"))
            {
                std::vector<std::string> countries = stand["Countries"].get<std::vector<std::string>>();
                std::string depCountry = pilot.origin;
                if (depCountry.length() >= 2)
                    depCountry = depCountry.substr(0, 2);
                else
                    depCountry.clear();
                bool isFromCountry = std::find(countries.begin(), countries.end(), depCountry) != countries.end();
                if (!isFromCountry)
                {
                    std::string allowed;
                    for (size_t i = 0; i < countries.size(); ++i)
                    {
                        if (i)
                            allowed += ',';
                        allowed += countries[i];
                    }
                    errorMessages.push_back("Removing stand " + it.key() + " due to Countries mismatch. Stand: " + allowed + " Pilot: " + depCountry);
                    it = standsJson.erase(it);
                    continue;
                }
            }
            // Callsigns
            if (stand.contains("Callsigns"))
            {
                std::vector<std::string> callsigns = stand["Callsigns"].get<std::vector<std::string>>();
                if (callsign.length() < 3 || std::find(callsigns.begin(), callsigns.end(), pilot.callsign.substr(0, 3)) == callsigns.end())
                {
                    errorMessages.push_back("Removing stand " + it.key() + " due to Callsign mismatch. Pilot: " + pilot.callsign);
                    it = standsJson.erase(it);
                    continue;
                }
            }
            // Occupied
            if (std::find_if(occupiedStands_.begin(), occupiedStands_.end(),
                             [&it, icao](const Stand &s)
                             { return it.key() == s.name && icao == s.icao; }) != occupiedStands_.end())
            {
                errorMessages.push_back("Removing stand " + it.key() + " because it is already occupied.");
                it = standsJson.erase(it);
                continue;
            }
            // Blocked
            if (std::find_if(blockedStands_.begin(), blockedStands_.end(),
                             [&it, icao](const Stand &s)
                             { return it.key() == s.name && icao == s.icao; }) != blockedStands_.end())
            {
                errorMessages.push_back("Removing stand " + it.key() + " because it is blocked.");
                it = standsJson.erase(it);
                continue;
            }
            ++it;
        }

        LOG_DEBUG(Logger::LogLevel::Info, "Total stands available after filtering: " + std::to_string(standsJson.size()));

        // Priority pass (keep only lowest integer Priority; drop missing)
        int lowestPriority = std::numeric_limits<int>::max();
        bool anyPriority = false;
        for (auto &[standName, s] : standsJson.items())
        {
            if (s.contains("Priority") && s["Priority"].is_number_integer())
            {
                int p = s["Priority"].get<int>();
                if (p < lowestPriority)
                    lowestPriority = p;
                anyPriority = true;
            }
        }
        if (anyPriority)
        {
            for (auto it2 = standsJson.begin(); it2 != standsJson.end();)
            {
                auto &s = it2.value();
                if (s.contains("Priority") && s["Priority"].is_number_integer())
                {
                    int p = s["Priority"].get<int>();
                    if (p != lowestPriority)
                    {
                        it2 = standsJson.erase(it2);
                        continue;
                    }
                }
                else
                {
                    it2 = standsJson.erase(it2);
                    continue;
                }
                ++it2;
            }
        }

        if (standsJson.empty())
        {
            if (!callsignError_.contains(pilot.callsign))
            {
                loggerAPI_->log(Logger::LogLevel::Warning, "No suitable stand found for pilot: " + pilot.callsign + " at " + pilot.destination);
                callsignError_.insert(pilot.callsign);
                needDump = true; // defer file write until after we release dataMutex_
            }
            pilot.stand = "";
            updatePilotStand(pilot.callsign, pilot.stand);
        }
        else
        {
            // Pick smallest-allowed Code among remaining
            char bestMaxCode = 'F';
            bool anyCode = false;
            auto selectedStandIt = standsJson.begin();
            for (auto it2 = standsJson.begin(); it2 != standsJson.end(); ++it2)
            {
                if (it2.value().contains("Code"))
                {
                    std::string code = it2.value()["Code"].get<std::string>();
                    if (!code.empty())
                    {
                        anyCode = true;
                        char maxCode = *std::max_element(code.begin(), code.end());
                        if (maxCode < bestMaxCode)
                        {
                            bestMaxCode = maxCode;
                            selectedStandIt = it2;
                        }
                    }
                }
            }

            auto selectedStand = standsJson.begin().value();
            std::string selectedStandName = standsJson.begin().key();
            if (anyCode)
            {
                selectedStandName = selectedStandIt.key();
                selectedStand = *selectedStandIt;
            }

            pilot.stand = selectedStandName;
            updatePilotStand(pilot.callsign, pilot.stand);
            LOG_DEBUG(Logger::LogLevel::Info, "Assigned stand " + pilot.stand + " to pilot: " + pilot.callsign);

            // Mark occupied unless Apron
            Stand stand;
            stand.name = pilot.stand;
            stand.icao = pilot.destination;
            stand.callsign = pilot.callsign;
            if (!selectedStand.contains("Apron") || !selectedStand["Apron"].get<bool>())
            {
                occupiedStands_.push_back(stand);
                if (selectedStand.contains("Block") && selectedStand["Block"].is_array())
                {
                    for (const auto &blockedStandName : selectedStand["Block"])
                    {
                        Stand blockedStand;
                        blockedStand.name = blockedStandName.get<std::string>();
                        blockedStand.icao = pilot.destination;
                        blockedStand.callsign = pilot.callsign;
                        if (std::find(blockedStands_.begin(), blockedStands_.end(), blockedStand) == blockedStands_.end())
                        {
                            blockedStands_.push_back(blockedStand);
                            LOG_DEBUG(Logger::LogLevel::Info, "Also blocking stand " + blockedStand.name + " due to assignment of " + pilot.stand);
                        }
                    }
                }
            }
        }
    }