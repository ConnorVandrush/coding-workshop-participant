#!/usr/bin/env python3
"""
Script: Seed the facility incident management database
Purpose: Populate the API with realistic demo data for the ACME workshop
Usage: ./bin/seed-database.py [--url URL] [--password PASSWORD] [--dry-run]

Seeding goes through the HTTP API rather than straight to PostgreSQL, for two
reasons:

1. Aurora has no public endpoint and its security group only admits traffic from
   itself, so only the Lambda can reach the database. The API is the supported
   path in from a laptop or the VDI.
2. Going through the API means passwords are hashed by the service itself, and
   every incident travels the real workflow, so the seeded data obeys the same
   validation and RBAC rules as anything a user creates.

The script is idempotent: records that already exist are reused, so it is safe
to re-run after a partial failure.

With no --url it reads the deployed CloudFront URL from the Terraform outputs,
falling back to the local dev proxy on http://localhost:3001.
"""

import argparse
import datetime
import json
import subprocess  # nosec B404 # used only to read local `terraform output`
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

SERVICE_PATH = "/api/facility-api"
DEFAULT_PASSWORD = "Workshop#2026"  # nosec B105 # demo credential, printed in the summary
DOMAIN = "acme.inc"

# --------------------------------------------------------------------------
# Seed data
# --------------------------------------------------------------------------
BUILDINGS: list[dict[str, Any]] = [
    {
        "name": "HQ North",
        "address": "1 Market Street, Jersey City, NJ",
        "floors": [
            {"level": 1, "name": "Reception & Cafeteria", "seats": ["1A-01", "1A-02", "1B-07"]},
            {"level": 2, "name": "Operations", "seats": ["2A-11", "2A-12", "2C-30"]},
            {"level": 3, "name": "Engineering", "seats": ["3A-12", "3A-13", "3B-21", "3C-04"]},
            {"level": 4, "name": "Executive", "seats": ["4A-01", "4A-02"]},
        ],
    },
    {
        "name": "Riverside Annex",
        "address": "88 Hudson Parkway, Jersey City, NJ",
        "floors": [
            {"level": 1, "name": "Client Briefing Centre", "seats": ["R1-05", "R1-06"]},
            {"level": 2, "name": "Shared Workspace", "seats": ["R2-14", "R2-15", "R2-16"]},
        ],
    },
    {
        "name": "Tech Pavilion",
        "address": "410 Innovation Way, Newark, NJ",
        "floors": [
            {"level": -1, "name": "Data Centre", "seats": ["B1-RACK-07"]},
            {"level": 1, "name": "Lab Floor", "seats": ["P1-03", "P1-04", "P1-09"]},
        ],
    },
]

# Equipment, one row per physical unit. Ages are expressed as months before the
# seeding run so that the maintenance figures stay meaningful however long after
# this script was written the database is built.
#
# The estate is deliberately uneven: the Meeting Room 3A projector is elderly
# and fails repeatedly, while its two siblings are healthy. That is what gives
# the maintenance screen something true to say - a unit flagged against the
# median of its own type, rather than against a number picked out of the air.
ASSETS: list[dict[str, Any]] = [
    {"code": "AV-3A-PROJ-01", "name": "Ceiling projector, Meeting Room 3A", "type": "PROJECTOR",
     "manufacturer": "Epson", "model": "EB-L200", "building": "HQ North", "floor": 3, "seat": "3A-12",
     "installed_months_ago": 74, "expected_life_months": 60, "service_interval_months": 12, "last_serviced_months_ago": 20},
    {"code": "AV-R1-PROJ-02", "name": "Briefing centre projector", "type": "PROJECTOR",
     "manufacturer": "Epson", "model": "EB-L520", "building": "Riverside Annex", "floor": 1, "seat": "R1-05",
     "installed_months_ago": 22, "expected_life_months": 60, "service_interval_months": 12, "last_serviced_months_ago": 4},
    {"code": "AV-4A-PROJ-03", "name": "Executive boardroom projector", "type": "PROJECTOR",
     "manufacturer": "Sony", "model": "VPL-FHZ70", "building": "HQ North", "floor": 4, "seat": "4A-01",
     "installed_months_ago": 14, "expected_life_months": 60, "service_interval_months": 12, "last_serviced_months_ago": 2},
    {"code": "AV-R1-MIC-01", "name": "Lapel microphone, briefing centre", "type": "MICROPHONE",
     "manufacturer": "Shure", "model": "BLX14", "building": "Riverside Annex", "floor": 1, "seat": "R1-06",
     "installed_months_ago": 26, "expected_life_months": 48},
    {"code": "HVAC-HQ2-AHU-04", "name": "Air handling unit, Level 2", "type": "HVAC_UNIT",
     "manufacturer": "Daikin", "model": "AHU-4000", "building": "HQ North", "floor": 2, "seat": "2A-11",
     "installed_months_ago": 108, "expected_life_months": 180, "service_interval_months": 6, "last_serviced_months_ago": 9},
    {"code": "HVAC-TP-CRAC-01", "name": "CRAC unit, data centre", "type": "HVAC_UNIT",
     "manufacturer": "Vertiv", "model": "Liebert PDX", "building": "Tech Pavilion", "floor": -1,
     "seat": "B1-RACK-07", "installed_months_ago": 96, "expected_life_months": 144, "service_interval_months": 3, "last_serviced_months_ago": 5},
    {"code": "HQ-1B-TAP-02", "name": "Cafeteria mixer tap", "type": "PLUMBING_FIXTURE",
     "manufacturer": "Grohe", "model": "Eurosmart", "building": "HQ North", "floor": 1, "seat": "1B-07",
     "installed_months_ago": 40, "expected_life_months": 120},
    {"code": "HQ-1A-DW-01", "name": "Cafeteria dishwasher", "type": "KITCHEN_APPLIANCE",
     "manufacturer": "Winterhalter", "model": "UC-M", "building": "HQ North", "floor": 1, "seat": "1A-02",
     "installed_months_ago": 84, "expected_life_months": 120, "service_interval_months": 12, "last_serviced_months_ago": 13},
    {"code": "HQ-2A12-DOCK-07", "name": "Laptop docking station, 2A-12", "type": "DOCKING_STATION",
     "manufacturer": "Dell", "model": "WD19TB", "building": "HQ North", "floor": 2, "seat": "2A-12",
     "installed_months_ago": 30, "expected_life_months": 48},
    {"code": "HQ-2C-EXIT-01", "name": "Emergency exit sign, Level 2 stairwell", "type": "EMERGENCY_LIGHT",
     "manufacturer": "Eaton", "model": "CrompX", "building": "HQ North", "floor": 2, "seat": "2C-30",
     "installed_months_ago": 92, "expected_life_months": 84, "service_interval_months": 12, "last_serviced_months_ago": 12},
    {"code": "HQ-3B21-DESK-01", "name": "Sit-stand desk, 3B-21", "type": "STANDING_DESK",
     "manufacturer": "Linak", "model": "DL11", "building": "HQ North", "floor": 3, "seat": "3B-21",
     "installed_months_ago": 52, "expected_life_months": 120},
    {"code": "RA-R2-PRT-14", "name": "Shared workspace printer", "type": "PRINTER",
     "manufacturer": "Ricoh", "model": "IM C3000", "building": "Riverside Annex", "floor": 2, "seat": "R2-14",
     "installed_months_ago": 66, "expected_life_months": 60, "service_interval_months": 6, "last_serviced_months_ago": 2},
    {"code": "RA-R1-BADGE-01", "name": "Badge reader, Annex main door", "type": "BADGE_READER",
     "manufacturer": "HID", "model": "Signo 20", "building": "Riverside Annex", "floor": 1, "seat": "R1-05",
     "installed_months_ago": 48, "expected_life_months": 96, "service_interval_months": 12, "last_serviced_months_ago": 6},
    {"code": "TP-B1-SW-07", "name": "Access switch, rack 7", "type": "NETWORK_SWITCH",
     "manufacturer": "Cisco", "model": "C9300-48P", "building": "Tech Pavilion", "floor": -1,
     "seat": "B1-RACK-07", "installed_months_ago": 34, "expected_life_months": 84, "service_interval_months": 24, "last_serviced_months_ago": 10},
    {"code": "TP-P1-AP-09", "name": "Wireless access point, Lab Floor south", "type": "ACCESS_POINT",
     "manufacturer": "Aruba", "model": "AP-515", "building": "Tech Pavilion", "floor": 1, "seat": "P1-09",
     "installed_months_ago": 64, "expected_life_months": 60, "service_interval_months": 24, "last_serviced_months_ago": 8},
    {"code": "TP-P1-PWR-04", "name": "Lab bench power distribution, P1-04", "type": "POWER_STRIP",
     "manufacturer": "APC", "model": "AP9571A", "building": "Tech Pavilion", "floor": 1, "seat": "P1-04",
     "installed_months_ago": 70, "expected_life_months": 60, "service_interval_months": 12, "last_serviced_months_ago": 11},
    {"code": "HQ-1A-PRT-01", "name": "Visitor voucher printer, reception", "type": "PRINTER",
     "manufacturer": "Brother", "model": "QL-820", "building": "HQ North", "floor": 1, "seat": "1A-01",
     "installed_months_ago": 28, "expected_life_months": 60, "service_interval_months": 12,
     "last_serviced_months_ago": 3},
    {"code": "HQ-3A-PANEL-12", "name": "Room booking panel, Meeting Room 3A", "type": "BOOKING_PANEL",
     "manufacturer": "Crestron", "model": "TSS-7", "building": "HQ North", "floor": 3, "seat": "3A-12",
     "installed_months_ago": 18, "expected_life_months": 72},
    {"code": "HQ-4A-LGT-01", "name": "Corridor lighting circuit, Level 4", "type": "LIGHTING",
     "manufacturer": "Philips", "model": "CoreLine", "building": "HQ North", "floor": 4, "seat": "4A-01",
     "installed_months_ago": 58, "expected_life_months": 96, "service_interval_months": 24,
     "last_serviced_months_ago": 26},
    {"code": "RA-R2-CHAIR-15", "name": "Task chair, R2-15", "type": "TASK_CHAIR",
     "manufacturer": "Herman Miller", "model": "Aeron", "building": "Riverside Annex", "floor": 2,
     "seat": "R2-15", "installed_months_ago": 76, "expected_life_months": 96},
]

EMPLOYEES: list[tuple[str, str]] = [
    ("dana.ruiz", "Dana Ruiz"),
    ("marcus.hale", "Marcus Hale"),
    ("priya.nair", "Priya Nair"),
    ("tomas.berg", "Tomas Berg"),
    ("yuki.tanaka", "Yuki Tanaka"),
    ("leila.ahmed", "Leila Ahmed"),
]

ENGINEERS: list[dict[str, Any]] = [
    {
        "login": "sam.okafor",
        "name": "Sam Okafor",
        "specialties": ["AV_EQUIPMENT", "HARDWARE", "NETWORK"],
        "phone": "+1-555-0101",
        "max_active_incidents": 8,
        "is_available": True,
    },
    {
        "login": "nora.feld",
        "name": "Nora Feld",
        "specialties": ["HVAC", "ELECTRICAL", "PLUMBING"],
        "phone": "+1-555-0102",
        "max_active_incidents": 6,
        "is_available": True,
    },
    {
        "login": "igor.petrov",
        "name": "Igor Petrov",
        "specialties": ["SOFTWARE", "NETWORK", "SECURITY"],
        "phone": "+1-555-0103",
        "max_active_incidents": 10,
        "is_available": True,
    },
    {
        "login": "ana.silva",
        "name": "Ana Silva",
        "specialties": ["FURNITURE", "CLEANING", "SECURITY"],
        "phone": "+1-555-0104",
        "max_active_incidents": 5,
        "is_available": False,
    },
]

# Each incident names its reporter, location and the workflow state to drive it
# to. "seat" is matched by code, "floor" by level within the named building.
INCIDENTS: list[dict[str, Any]] = [
    {
        "title": "Projector will not power on in Meeting Room 3A",
        "asset": "AV-3A-PROJ-01",
        "description": "The ceiling projector in 3A shows no power light. We have a client demo on Thursday.",
        "category": "AV_EQUIPMENT", "priority": "HIGH", "reporter": "dana.ruiz",
        "building": "HQ North", "floor": 3, "seat": "3A-12",
        "state": "in_progress", "engineer": "sam.okafor",
        "notes": [("dana.ruiz", "Tried a different HDMI cable, no change.", False),
                  ("sam.okafor", "Lamp hours look exhausted. Ordering a replacement.", False)],
    },
    {
        "title": "Air conditioning leaking over desks on level 2",
        "asset": "HVAC-HQ2-AHU-04",
        "description": "Water is dripping from the ceiling tile above the operations pod. Desks have been moved.",
        "category": "HVAC", "priority": "CRITICAL", "reporter": "marcus.hale",
        "building": "HQ North", "floor": 2, "seat": "2A-11",
        "state": "blocked", "engineer": "nora.feld",
        "blocked_reason": "Roof access requires the building landlord, scheduled for Monday.",
        "escalate": "Water is close to the floor power distribution units.",
        "notes": [("nora.feld", "Contained with a drip tray, monitoring twice daily.", False),
                  ("nora.feld", "Landlord ticket LL-4471 raised.", True)],
    },
    {
        "title": "Badge reader rejecting valid passes at the Annex entrance",
        "asset": "RA-R1-BADGE-01",
        "description": "Roughly one in three taps is rejected at the Riverside Annex main door.",
        "category": "SECURITY", "priority": "HIGH", "reporter": "priya.nair",
        "building": "Riverside Annex", "floor": 1, "seat": "R1-05",
        "state": "resolved", "engineer": "igor.petrov",
        "resolution": "Reader firmware was two versions behind; updated and re-calibrated.",
        "notes": [("priya.nair", "Happening most often with older blue badges.", False)],
    },
    {
        "title": "Standing desk motor jammed at 3B-21",
        "asset": "HQ-3B21-DESK-01",
        "description": "The desk is stuck in the raised position and clicks when the down button is pressed.",
        "category": "FURNITURE", "priority": "LOW", "reporter": "tomas.berg",
        "building": "HQ North", "floor": 3, "seat": "3B-21",
        "state": "closed", "engineer": "ana.silva",
        "resolution": "Replaced the control box under warranty.",
        "notes": [],
    },
    {
        "title": "Wi-Fi drops repeatedly in the Lab Floor south corner",
        "asset": "TP-P1-AP-09",
        "description": "Connection drops every few minutes near P1-09. Ethernet is fine.",
        "category": "NETWORK", "priority": "MEDIUM", "reporter": "yuki.tanaka",
        "building": "Tech Pavilion", "floor": 1, "seat": "P1-09",
        "state": "in_progress", "engineer": "igor.petrov",
        "notes": [("igor.petrov", "Survey shows a coverage hole; proposing an extra access point.", False)],
    },
    {
        "title": "Data centre rack 7 running hot",
        "asset": "HVAC-TP-CRAC-01",
        "description": "Rack 7 inlet temperature is consistently above 27C. Alarm threshold is 25C.",
        "category": "HVAC", "priority": "CRITICAL", "reporter": "yuki.tanaka",
        "building": "Tech Pavilion", "floor": -1, "seat": "B1-RACK-07",
        "state": "in_progress", "engineer": "nora.feld",
        "escalate": "Risk of thermal shutdown on production hardware.",
        "notes": [("nora.feld", "Portable cooling unit in place while the CRAC unit is serviced.", False)],
    },
    {
        "title": "Kitchen tap running continuously on level 1",
        "asset": "HQ-1B-TAP-02",
        "description": "The cafeteria tap will not shut off fully and wastes water overnight.",
        "category": "PLUMBING", "priority": "MEDIUM", "reporter": "leila.ahmed",
        "building": "HQ North", "floor": 1, "seat": "1B-07",
        "state": "resolved", "engineer": "nora.feld",
        "resolution": "Replaced a worn ceramic cartridge.",
        "notes": [],
    },
    {
        "title": "Laptop docking station not charging",
        "asset": "HQ-2A12-DOCK-07",
        "description": "The dock at 2A-12 powers the monitors but no longer charges the laptop.",
        "category": "HARDWARE", "priority": "MEDIUM", "reporter": "marcus.hale",
        "building": "HQ North", "floor": 2, "seat": "2A-12",
        "state": "assigned", "engineer": "sam.okafor",
        "notes": [],
    },
    {
        "title": "Flickering lights above the executive corridor",
        "asset": "HQ-4A-LGT-01",
        "description": "Two ceiling panels flicker intermittently, worse in the afternoon.",
        "category": "ELECTRICAL", "priority": "LOW", "reporter": "dana.ruiz",
        "building": "HQ North", "floor": 4, "seat": "4A-01",
        "state": "open", "notes": [],
    },
    {
        "title": "Expense portal rejects PDF receipts over 2MB",
        "description": "Uploading a scanned receipt returns a generic error with no guidance.",
        "category": "SOFTWARE", "priority": "MEDIUM", "reporter": "priya.nair",
        "building": "HQ North", "floor": 3, "seat": "3C-04",
        "state": "blocked", "engineer": "igor.petrov",
        "blocked_reason": "Waiting on the finance system vendor to confirm the upload limit.",
        "notes": [("igor.petrov", "Vendor case #88210 open.", True)],
    },
    {
        "title": "Shared workspace printer jams on every duplex job",
        "asset": "RA-R2-PRT-14",
        "description": "Single-sided printing works; duplex jams in the rear tray each time.",
        "category": "HARDWARE", "priority": "LOW", "reporter": "tomas.berg",
        "building": "Riverside Annex", "floor": 2, "seat": "R2-14",
        "state": "open", "notes": [],
    },
    {
        "title": "Briefing centre microphone produces loud feedback",
        "asset": "AV-R1-MIC-01",
        "description": "The lapel microphone squeals whenever the presenter walks towards the screen.",
        "category": "AV_EQUIPMENT", "priority": "HIGH", "reporter": "leila.ahmed",
        "building": "Riverside Annex", "floor": 1, "seat": "R1-06",
        "state": "assigned", "engineer": "sam.okafor",
        "escalate": "Board briefing scheduled in this room on Friday.",
        "notes": [],
    },
    {
        "title": "Desk chair gas lift collapsed at R2-15",
        "asset": "RA-R2-CHAIR-15",
        "description": "The chair sinks to its lowest position as soon as anyone sits down.",
        "category": "FURNITURE", "priority": "LOW", "reporter": "yuki.tanaka",
        "building": "Riverside Annex", "floor": 2, "seat": "R2-15",
        "state": "closed", "engineer": "ana.silva",
        "resolution": "Chair swapped from stock; damaged unit sent for recycling.",
        "notes": [],
    },
    {
        "title": "Recycling bins not emptied on the Lab Floor",
        "description": "Bins have been full since Monday and cardboard is stacking up in the walkway.",
        "category": "CLEANING", "priority": "MEDIUM", "reporter": "yuki.tanaka",
        "building": "Tech Pavilion", "floor": 1, "seat": "P1-03",
        "state": "resolved", "engineer": "ana.silva",
        "resolution": "Collection schedule corrected with the facilities contractor.",
        "notes": [],
    },
    {
        "title": "VPN client disconnects when switching to the guest network",
        "description": "Reconnecting requires a full restart of the client.",
        "category": "SOFTWARE", "priority": "MEDIUM", "reporter": "marcus.hale",
        "building": "HQ North", "floor": 3, "seat": "3A-13",
        "state": "open", "notes": [],
    },
    {
        "title": "Emergency exit light out on level 2 stairwell",
        "asset": "HQ-2C-EXIT-01",
        "description": "The illuminated exit sign above the stairwell door is dark.",
        "category": "ELECTRICAL", "priority": "HIGH", "reporter": "priya.nair",
        "building": "HQ North", "floor": 2, "seat": "2C-30",
        "state": "resolved", "engineer": "nora.feld",
        "resolution": "Replaced the failed LED module and tested the battery backup.",
        "escalate": "Fire safety compliance issue.",
        "notes": [],
    },
    {
        "title": "Guest Wi-Fi voucher printer out of paper",
        "asset": "HQ-1A-PRT-01",
        "description": "Reception cannot issue visitor Wi-Fi codes.",
        "category": "OTHER", "priority": "LOW", "reporter": "dana.ruiz",
        "building": "HQ North", "floor": 1, "seat": "1A-01",
        "state": "closed", "engineer": "sam.okafor",
        "resolution": "Restocked paper and left a spare roll with reception.",
        "notes": [],
    },
    {
        "title": "Meeting room booking panel shows the wrong room name",
        "asset": "HQ-3A-PANEL-12",
        "description": "The panel outside 3A displays 'Room 3B', confusing attendees.",
        "category": "SOFTWARE", "priority": "LOW", "reporter": "tomas.berg",
        "building": "HQ North", "floor": 3, "seat": "3A-12",
        "state": "open", "notes": [],
    },
    {
        "title": "Cold draught from the window seal at 4A-02",
        "description": "Noticeable draught and condensation on the inside of the glass.",
        "category": "HVAC", "priority": "LOW", "reporter": "leila.ahmed",
        "building": "HQ North", "floor": 4, "seat": "4A-02",
        "state": "assigned", "engineer": "nora.feld",
        "notes": [],
    },
    {
        "title": "Lab bench power strip tripping the circuit",
        "asset": "TP-P1-PWR-04",
        "description": "Plugging in the test rig at P1-04 trips the breaker for the whole bench.",
        "category": "ELECTRICAL", "priority": "HIGH", "reporter": "yuki.tanaka",
        "building": "Tech Pavilion", "floor": 1, "seat": "P1-04",
        "state": "in_progress", "engineer": "nora.feld",
        "notes": [("nora.feld", "Suspect the rig exceeds the bench circuit rating; measuring load.", False)],
    },
    {
        "title": "Door closer slamming on the Annex fire door",
        "description": "The door slams loudly enough to be heard across the floor.",
        "category": "OTHER", "priority": "LOW", "reporter": "priya.nair",
        "building": "Riverside Annex", "floor": 2, "seat": "R2-16",
        "state": "open", "notes": [],
    },
    {
        "title": "Monitor arm will not hold position at 3C-04",
        "description": "The arm drifts downwards over the course of the day.",
        "category": "FURNITURE", "priority": "LOW", "reporter": "dana.ruiz",
        "building": "HQ North", "floor": 3, "seat": "3C-04",
        "state": "open", "notes": [],
    },
    {
        "title": "Network switch port dead in rack 7",
        "asset": "TP-B1-SW-07",
        "description": "Port 14 shows no link light with three different known-good cables.",
        "category": "NETWORK", "priority": "HIGH", "reporter": "yuki.tanaka",
        "building": "Tech Pavilion", "floor": -1, "seat": "B1-RACK-07",
        "state": "resolved", "engineer": "igor.petrov",
        "resolution": "Port disabled in config by an old change; re-enabled and documented.",
        "notes": [],
    },
    {
        "title": "Cafeteria dishwasher leaving residue on trays",
        "asset": "HQ-1A-DW-01",
        "description": "Trays come out with a white film. Possibly a rinse aid problem.",
        "category": "CLEANING", "priority": "MEDIUM", "reporter": "marcus.hale",
        "building": "HQ North", "floor": 1, "seat": "1A-02",
        "state": "open", "notes": [],
    },
    {
        "title": "Projector lamp failed again in Meeting Room 3A",
        "asset": "AV-3A-PROJ-01",
        "description": "Second lamp failure on this unit since the spring. Replaced under warranty last time.",
        "category": "AV_EQUIPMENT", "priority": "MEDIUM", "reporter": "marcus.hale",
        "building": "HQ North", "floor": 3, "seat": "3A-12",
        "state": "closed", "engineer": "sam.okafor",
        "resolution": "Fitted a new lamp module and reset the hour counter.",
        "notes": [("sam.okafor", "Third call-out on this projector. Worth pricing a replacement.", True)],
    },
    {
        "title": "Projector shuts down mid-presentation in Meeting Room 3A",
        "asset": "AV-3A-PROJ-01",
        "description": "The unit powers off after roughly twenty minutes and will not restart until it cools.",
        "category": "AV_EQUIPMENT", "priority": "HIGH", "reporter": "priya.nair",
        "building": "HQ North", "floor": 3, "seat": "3A-12",
        "state": "resolved", "engineer": "sam.okafor",
        "resolution": "Cleared a blocked intake filter; thermal cut-out was tripping.",
        "notes": [],
    },
    {
        "title": "Projector fan noise in Meeting Room 3A",
        "asset": "AV-3A-PROJ-01",
        "description": "Loud rattling from the projector housing whenever it is running.",
        "category": "AV_EQUIPMENT", "priority": "LOW", "reporter": "dana.ruiz",
        "building": "HQ North", "floor": 3, "seat": "3A-12",
        "state": "open", "notes": [],
    },
    {
        "title": "Briefing centre projector shows a blue tint",
        "asset": "AV-R1-PROJ-02",
        "description": "Whites render blue on the briefing centre screen since the room was rearranged.",
        "category": "AV_EQUIPMENT", "priority": "LOW", "reporter": "leila.ahmed",
        "building": "Riverside Annex", "floor": 1, "seat": "R1-05",
        "state": "resolved", "engineer": "sam.okafor",
        "resolution": "Colour profile reset to factory defaults.",
        "notes": [],
    },
    {
        "title": "Boardroom projector remote unresponsive",
        "asset": "AV-4A-PROJ-03",
        "description": "The handset does nothing; the unit still works from the wall panel.",
        "category": "AV_EQUIPMENT", "priority": "LOW", "reporter": "tomas.berg",
        "building": "HQ North", "floor": 4, "seat": "4A-01",
        "state": "closed", "engineer": "sam.okafor",
        "resolution": "Replaced the handset batteries and re-paired it.",
        "notes": [],
    },
]


class ApiError(RuntimeError):
    """Raised when the API returns an unexpected status code."""


class Client:
    """
    Minimal JSON HTTP client for the facility API.

    Args:
        base_url: Root URL including the service path.
        dry_run: When True, log writes instead of sending them.
    """

    def __init__(self, base_url: str, dry_run: bool = False) -> None:
        self.base_url = base_url.rstrip("/")
        self.dry_run = dry_run
        self.tokens: dict[str, str] = {}

    def request(
        self,
        method: str,
        path: str,
        body: Optional[dict] = None,
        token: Optional[str] = None,
        expect: tuple[int, ...] = (200, 201, 204),
    ) -> tuple[int, Any]:
        """
        Send one request and decode the JSON response.

        Args:
            method: HTTP method.
            path: Path relative to the service root, e.g. ``/incidents``.
            body: JSON body to send.
            token: Bearer token for authenticated calls.
            expect: Status codes treated as success.

        Returns:
            tuple[int, Any]: The status code and decoded body (None for 204).

        Raises:
            ApiError: When the status code is outside ``expect``.
        """
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:  # nosec B310 # scheme is validated in main()
                payload = response.read().decode("utf-8")
                return response.status, (json.loads(payload) if payload else None)
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8")
            parsed = json.loads(payload) if payload.startswith("{") else payload
            if exc.code in expect:
                return exc.code, parsed
            raise ApiError(f"{method} {path} -> {exc.code}: {parsed}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"{method} {path} -> unreachable: {exc.reason}") from exc

    def login(self, email: str, password: str) -> str:
        """
        Authenticate and cache the bearer token for an account.

        Args:
            email: The account's address.
            password: The account's password.

        Returns:
            str: The bearer token.
        """
        if email not in self.tokens:
            _, body = self.request("POST", "/auth/login", {"email": email, "password": password})
            self.tokens[email] = body["access_token"]
        return self.tokens[email]


# --------------------------------------------------------------------------
# Idempotent helpers
# --------------------------------------------------------------------------
def email_for(login: str) -> str:
    """
    Build the corporate address for a seed login.

    Args:
        login: The local part, e.g. ``dana.ruiz``.

    Returns:
        str: The full ``@acme.inc`` address.
    """
    return f"{login}@{DOMAIN}"


def ensure_user(client: Client, login: str, name: str, password: str, admin_token: Optional[str] = None) -> dict:
    """
    Register an account, tolerating one that already exists.

    Args:
        client: The API client.
        login: Local part of the address.
        name: Full name.
        password: Password to set (ignored if the account exists).
        admin_token: A facility-admin token, used to reactivate the account if
            testing has left it deactivated.

    Returns:
        dict: ``{"email": ..., "id": ...}`` for the account.

    Raises:
        ApiError: When the account cannot be brought back into a usable state.
    """
    email = email_for(login)
    status, body = client.request(
        "POST",
        "/auth/register",
        {"email": email, "full_name": name, "password": password},
        expect=(201, 409),
    )
    if status == 201:
        return {"email": email, "id": body["id"], "created": True}

    # Already present: identify it by authenticating as that account.
    try:
        token = client.login(email, password)
    except ApiError as exc:
        # Deactivating an account is one of the things this application is for,
        # so a database that has been used will have deactivated accounts in it
        # - including, sooner or later, a seeded one. Seeding is meant to
        # converge on a known-good demo state, so it puts the account back
        # rather than stopping and asking someone to do it by hand.
        if "account_disabled" not in str(exc) or admin_token is None:
            raise
        print(f"    {email} was deactivated; reactivating it")
        # `GET /users` answers with a plain list, unlike the paged incident list.
        _, accounts = client.request(
            "GET", f"/users?q={urllib.parse.quote(email)}&limit=50", token=admin_token
        )
        match = next((item for item in accounts if item["email"] == email), None)
        if match is None:
            raise
        client.request("PATCH", f"/users/{match['id']}/status", {"is_active": True}, token=admin_token)
        token = client.login(email, password)

    _, me = client.request("GET", "/auth/me", token=token)
    return {"email": email, "id": me["id"], "created": False}


def ensure_building(client: Client, token: str, spec: dict) -> dict:
    """
    Create a building or return the existing one with the same name.

    Args:
        client: The API client.
        token: A facility-admin token.
        spec: Building specification from ``BUILDINGS``.

    Returns:
        dict: The building record.
    """
    status, body = client.request(
        "POST",
        "/buildings",
        {"name": spec["name"], "address": spec["address"]},
        token=token,
        expect=(201, 409),
    )
    if status == 201:
        return body
    _, existing = client.request("GET", f"/buildings?q={urllib.parse.quote(spec['name'])}", token=token)
    return next(item for item in existing if item["name"] == spec["name"])


def ensure_floor(client: Client, token: str, building_id: int, spec: dict) -> dict:
    """
    Create a floor or return the existing one at the same level.

    Args:
        client: The API client.
        token: A facility-admin token.
        building_id: Parent building id.
        spec: Floor specification.

    Returns:
        dict: The floor record.
    """
    status, body = client.request(
        "POST",
        f"/buildings/{building_id}/floors",
        {"level": spec["level"], "name": spec["name"]},
        token=token,
        expect=(201, 409),
    )
    if status == 201:
        return body
    _, existing = client.request("GET", f"/buildings/{building_id}/floors", token=token)
    return next(item for item in existing if item["level"] == spec["level"])


def ensure_seat(client: Client, token: str, floor_id: int, code: str) -> dict:
    """
    Create a seat or return the existing one with the same code.

    Args:
        client: The API client.
        token: A facility-admin token.
        floor_id: Parent floor id.
        code: Seat code.

    Returns:
        dict: The seat record.
    """
    status, body = client.request(
        "POST", f"/floors/{floor_id}/seats", {"code": code}, token=token, expect=(201, 409)
    )
    if status == 201:
        return body
    _, existing = client.request("GET", f"/floors/{floor_id}/seats", token=token)
    return next(item for item in existing if item["code"] == code)


def ensure_asset(client: Client, token: str, ctx: dict, spec: dict) -> dict:
    """
    Register one unit of equipment, reusing it when the code already exists.

    Args:
        client: The API client.
        token: A facility admin token.
        ctx: Seeding context holding the building/floor/seat lookups.
        spec: One entry from ``ASSETS``.

    Returns:
        dict: The asset record.
    """
    query = urllib.parse.quote(spec["code"])
    _, existing = client.request("GET", f"/assets?q={query}&include_retired=true", token=token)
    for row in existing:
        if row["code"] == spec["code"]:
            return row

    # Ages are stored as months-before-now so the fixture does not quietly age
    # into nonsense; 30.44 is the mean month length, which is accurate enough
    # for a figure the UI rounds to one decimal place.
    installed = datetime.date.today() - datetime.timedelta(days=round(spec["installed_months_ago"] * 30.44))
    last_serviced = (
        datetime.date.today() - datetime.timedelta(days=round(spec["last_serviced_months_ago"] * 30.44))
        if spec.get("last_serviced_months_ago") is not None
        else None
    )
    building = ctx["buildings"][spec["building"]]
    floor = ctx["floors"][(spec["building"], spec["floor"])]
    seat = ctx["seats"][(spec["building"], spec["floor"], spec["seat"])]

    _, asset = client.request(
        "POST",
        "/assets",
        {
            "code": spec["code"],
            "name": spec["name"],
            "asset_type": spec["type"],
            "manufacturer": spec.get("manufacturer"),
            "model": spec.get("model"),
            "building_id": building["id"],
            "floor_id": floor["id"],
            "seat_id": seat["id"],
            "installed_on": installed.isoformat(),
            "expected_life_months": spec["expected_life_months"],
            "service_interval_months": spec.get("service_interval_months"),
            "last_serviced_on": last_serviced.isoformat() if last_serviced else None,
        },
        token=token,
        expect=(201,),
    )
    return asset


def ensure_engineer(client: Client, token: str, user_id: int, spec: dict) -> dict:
    """
    Create an engineer profile, or return the existing one for that user.

    Profiles are always created available so that seeding can assign work to
    them; the configured availability is applied afterwards.

    Args:
        client: The API client.
        token: A facility-admin token.
        user_id: The account to promote.
        spec: Engineer specification from ``ENGINEERS``.

    Returns:
        dict: The engineer profile record.
    """
    status, body = client.request(
        "POST",
        "/engineers",
        {
            "user_id": user_id,
            "specialties": spec["specialties"],
            "phone": spec["phone"],
            "is_available": True,
            "max_active_incidents": spec["max_active_incidents"],
        },
        token=token,
        expect=(201, 409),
    )
    if status == 201:
        return body
    _, existing = client.request("GET", "/engineers", token=token)
    return next(item for item in existing if item["user_id"] == user_id)


# --------------------------------------------------------------------------
# Incident workflow
# --------------------------------------------------------------------------
# Each state implies the transitions needed to reach it from OPEN.
STATE_PATH: dict[str, tuple[str, ...]] = {
    "open": (),
    "assigned": (),
    "in_progress": ("IN_PROGRESS",),
    "blocked": ("IN_PROGRESS", "BLOCKED"),
    "resolved": ("IN_PROGRESS", "RESOLVED"),
    "closed": ("IN_PROGRESS", "RESOLVED", "CLOSED"),
}


def seed_incident(client: Client, ctx: dict, spec: dict, password: str) -> Optional[int]:
    """
    Create one incident and drive it to its target workflow state.

    Args:
        client: The API client.
        ctx: Seeding context with tokens and the id lookups.
        spec: Incident specification from ``INCIDENTS``.
        password: The shared seed password.

    Returns:
        int | None: The incident id, or None when it already existed.
    """
    admin_token = ctx["admin_token"]

    # Idempotency: an incident with this exact title is left alone, except for
    # one thing. A database seeded before the equipment register existed has
    # every incident but none of the links to a unit, and skipping outright
    # would leave it that way however often this is re-run - so an existing
    # incident that should name a unit, and does not, is updated in place.
    query = urllib.parse.quote(spec["title"][:60])
    _, page = client.request("GET", f"/incidents?q={query}&limit=100", token=admin_token)
    existing = next((item for item in page["items"] if item["title"] == spec["title"]), None)
    if existing is not None:
        asset = ctx["assets"].get(spec["asset"]) if spec.get("asset") else None
        if asset and not existing.get("asset"):
            client.request(
                "PUT",
                f"/incidents/{existing['id']}",
                {"asset_id": asset["id"]},
                token=admin_token,
            )
            return existing["id"]
        return None

    building = ctx["buildings"][spec["building"]]
    floor = ctx["floors"][(spec["building"], spec["floor"])]
    seat = ctx["seats"][(spec["building"], spec["floor"], spec["seat"])]

    reporter_token = client.login(email_for(spec["reporter"]), password)
    _, incident = client.request(
        "POST",
        "/incidents",
        {
            "title": spec["title"],
            "description": spec["description"],
            "category": spec["category"],
            "priority": spec["priority"],
            "building_id": building["id"],
            "floor_id": floor["id"],
            "seat_id": seat["id"],
            "asset_id": (ctx["assets"].get(spec["asset"]) or {}).get("id") if spec.get("asset") else None,
        },
        token=reporter_token,
    )
    incident_id = incident["id"]

    engineer_login = spec.get("engineer")
    if engineer_login:
        engineer = ctx["engineers"][engineer_login]
        client.request(
            "POST",
            f"/incidents/{incident_id}/assign",
            {"engineer_id": engineer["id"], "note": f"Routed to {engineer['full_name']} by triage."},
            token=admin_token,
        )
        engineer_token = client.login(email_for(engineer_login), password)

        for target in STATE_PATH[spec["state"]]:
            payload: dict[str, Any] = {"status": target}
            if target == "BLOCKED":
                payload["reason"] = spec["blocked_reason"]
            if target == "RESOLVED":
                payload["resolution"] = spec["resolution"]
            # The reporter confirms the fix by closing; staff do everything else.
            actor = reporter_token if target == "CLOSED" else engineer_token
            client.request("POST", f"/incidents/{incident_id}/status", payload, token=actor)

    if spec.get("escalate"):
        client.request(
            "POST",
            f"/incidents/{incident_id}/escalate",
            {"is_escalated": True, "reason": spec["escalate"]},
            token=admin_token,
        )

    for author, body, internal in spec.get("notes", []):
        client.request(
            "POST",
            f"/incidents/{incident_id}/notes",
            {"body": body, "is_internal": internal},
            token=client.login(email_for(author), password),
            expect=(201, 409),
        )

    return incident_id


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
def resolve_base_url(explicit: Optional[str]) -> str:
    """
    Work out which deployment to seed.

    Args:
        explicit: A URL supplied on the command line, if any.

    Returns:
        str: The service root URL, including the service path.
    """
    if explicit:
        root = explicit.rstrip("/")
        return root if root.endswith(SERVICE_PATH) else f"{root}{SERVICE_PATH}"

    try:
        output = subprocess.run(  # nosec B603 B607 # fixed argv, no shell, local tool
            ["terraform", "output", "-raw", "api_base_url"],
            cwd="infra",
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        candidate = output.stdout.strip()
        if candidate.startswith("http"):
            return f"{candidate}{SERVICE_PATH}"
    except (OSError, subprocess.SubprocessError):
        pass

    return f"http://localhost:3001{SERVICE_PATH}"


def main() -> int:
    """
    Seed the deployment and print a summary.

    Returns:
        int: Process exit code.
    """
    parser = argparse.ArgumentParser(description="Seed the ACME facility incident API with demo data.")
    parser.add_argument("--url", help="Service root URL (default: Terraform api_base_url, else localhost:3001)")
    parser.add_argument("--password", default=DEFAULT_PASSWORD, help="Password for every seeded account")
    parser.add_argument("--dry-run", action="store_true", help="Print the target and exit without writing")
    args = parser.parse_args()

    base_url = resolve_base_url(args.url)
    if not base_url.startswith(("http://", "https://")):
        print(f"ERROR: unsupported URL scheme: {base_url}", file=sys.stderr)
        return 2

    print("=" * 62)
    print("Coding Workshop - Seed Facility Incident Database")
    print("=" * 62)
    print(f"Target: {base_url}\n")

    client = Client(base_url, dry_run=args.dry_run)

    try:
        _, health = client.request("GET", "/health")
        print(f"  API reachable, database: {health['database'][:48]}...")
    except ApiError as exc:
        print(f"ERROR: API is not reachable - {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        print("\nDry run: no data written.")
        return 0

    password = args.password

    # 1. Accounts. The very first account in an empty database becomes the
    #    facility admin, so it must be registered before anything else.
    admin = ensure_user(client, "admin", "Ada Admin", password)
    admin_token = client.login(admin["email"], password)
    _, me = client.request("GET", "/auth/me", token=admin_token)
    if me["role"] != "facility_admin":
        print(
            f"ERROR: {admin['email']} has role '{me['role']}', not facility_admin.\n"
            "       The database already contained accounts before seeding, so the\n"
            "       bootstrap admin is someone else. Promote this account first.",
            file=sys.stderr,
        )
        return 1
    print(f"  Facility admin: {admin['email']}")

    for login, name in EMPLOYEES:
        ensure_user(client, login, name, password, admin_token)
    print(f"  Employees: {len(EMPLOYEES)}")

    # 2. Facilities.
    ctx: dict[str, Any] = {
        "admin_token": admin_token,
        "buildings": {},
        "floors": {},
        "seats": {},
        "engineers": {},
        "assets": {},
    }
    seat_total = 0
    for spec in BUILDINGS:
        building = ensure_building(client, admin_token, spec)
        ctx["buildings"][spec["name"]] = building
        for floor_spec in spec["floors"]:
            floor = ensure_floor(client, admin_token, building["id"], floor_spec)
            ctx["floors"][(spec["name"], floor_spec["level"])] = floor
            for code in floor_spec["seats"]:
                ctx["seats"][(spec["name"], floor_spec["level"], code)] = ensure_seat(
                    client, admin_token, floor["id"], code
                )
                seat_total += 1
    print(f"  Facilities: {len(BUILDINGS)} buildings, "
          f"{sum(len(b['floors']) for b in BUILDINGS)} floors, {seat_total} seats")

    # 3. Equipment, placed before the incidents that are filed against it.
    for spec in ASSETS:
        ctx["assets"][spec["code"]] = ensure_asset(client, admin_token, ctx, spec)
    print(f"  Equipment: {len(ASSETS)} units")

    # 4. Engineers, created available so that seeding can assign work to them.
    for spec in ENGINEERS:
        user = ensure_user(client, spec["login"], spec["name"], password, admin_token)
        profile = ensure_engineer(client, admin_token, user["id"], spec)
        ctx["engineers"][spec["login"]] = profile
    print(f"  Engineers: {len(ENGINEERS)}")

    # 5. Incidents, each driven through the real workflow.
    created = 0
    skipped = 0
    for spec in INCIDENTS:
        incident_id = seed_incident(client, ctx, spec, password)
        if incident_id is None:
            skipped += 1
        else:
            created += 1
    print(f"  Incidents: {created} created or linked to equipment, {skipped} already present")

    # 6. Apply the configured availability now that assignments are done.
    for spec in ENGINEERS:
        if not spec["is_available"]:
            client.request(
                "PUT",
                f"/engineers/{ctx['engineers'][spec['login']]['id']}",
                {"is_available": False},
                token=admin_token,
            )

    # 7. Summary straight from the dashboard, as a facility admin sees it.
    _, summary = client.request("GET", "/dashboard/summary", token=admin_token)
    print("\n" + "-" * 62)
    print("Dashboard summary")
    print("-" * 62)
    print(f"  Total incidents : {summary['total']}")
    print(f"  Open / active   : {summary['open_total']}")
    print(f"  Escalated       : {summary['escalated_total']}")
    print(f"  Unassigned      : {summary['unassigned_total']}")
    print(f"  By status       : " + ", ".join(f"{b['key']}={b['count']}" for b in summary["by_status"]))
    print(f"  By priority     : " + ", ".join(f"{b['key']}={b['count']}" for b in summary["by_priority"]))

    _, upkeep = client.request("GET", "/maintenance/summary", token=admin_token)
    print("\n" + "-" * 62)
    print("Maintenance")
    print("-" * 62)
    print(f"  Units tracked   : {upkeep['assets_tracked']}")
    print(f"  Needing review  : {upkeep['assets_needing_review']}")
    print(f"  Past their life : {upkeep['assets_past_expected_life']}")
    print(f"  Service overdue : {upkeep['assets_service_overdue']}")
    print(f"  Service due soon: {upkeep['assets_service_due_soon']}")
    print(f"  No interval set : {upkeep['assets_without_service_interval']}")
    print(f"  Incidents linked: {upkeep['incidents_linked']}/{upkeep['incidents_total']}"
          f" ({upkeep['linked_percent']}%)")

    print("\n" + "-" * 62)
    print(f"Sign-in credentials (password for every account: {password})")
    print("-" * 62)
    print(f"  Facility admin : {email_for('admin')}")
    print(f"  Engineer       : {email_for(ENGINEERS[0]['login'])}")
    print(f"  Employee       : {email_for(EMPLOYEES[0][0])}")
    print(f"\n  API docs       : {base_url}/docs")
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
