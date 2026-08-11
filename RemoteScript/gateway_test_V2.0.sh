#!/usr/bin/env bash
# ==============================================================================
# gateway_test.sh — V2.0
# Test automatico gateway Edge / Techbase
# Eseguire da WSL: bash gateway_test_V2.0.sh <IP_HOST>
# Dipendenze WSL: sshpass, psql
#   sudo apt install sshpass postgresql-client
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------------------------
DB_HOST="10.11.12.8"
DB_PORT="5432"
DB_NAME="device_db"
DB_USER="tester"
DB_PASS='GRPsmt.2014!'

SSH_USER="sgw"
SSH_PASS='Eu4Ph3ehKtWVGmd@xw96'
# StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null → ignora sempre la chiave host
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR"

COMMON_SERVICES=("apnchanger" "sshd" "raptor" "raptorwatchdog")
REQUIRED_IFACES=("wlan0" "wwan0")

# ------------------------------------------------------------------------------
# COLORI
# ------------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# ------------------------------------------------------------------------------
# FUNZIONI
# ------------------------------------------------------------------------------

usage() {
    echo "Uso: $0 <IP_GATEWAY>"
    echo "  Esempio: $0 192.168.1.100"
    exit 1
}

log_ok()   { echo -e "  ${GREEN}[OK]${NC}  $1"; }
log_fail() { echo -e "  ${RED}[FAIL]${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
log_info() { echo -e "  ${CYAN}[INFO]${NC} $1"; }

ssh_run() {
    sshpass -p "$SSH_PASS" ssh $SSH_OPTS "${SSH_USER}@${GW_IP}" "$1" 2>/dev/null
}

# Servizi normali: controlla is-active
check_service() {
    local svc="$1"
    local status
    status=$(ssh_run "systemctl is-active ${svc} 2>/dev/null || true")
    if [[ "$status" == "active" ]]; then
        log_ok  "Servizio ${svc}: active"
        return 0
    else
        log_fail "Servizio ${svc}: ${status:-non trovato}"
        return 1
    fi
}

# Servizi oneshot: controlla che Result=success (rimane anche dopo la fine)
check_oneshot_service() {
    local svc="$1"
    local result
    result=$(ssh_run "systemctl show ${svc} --property=Result 2>/dev/null | cut -d= -f2" || true)
    if [[ "$result" == "success" ]]; then
        log_ok  "Servizio oneshot ${svc}: eseguito con successo"
        return 0
    else
        log_fail "Servizio oneshot ${svc}: Result=${result:-non trovato}"
        return 1
    fi
}

check_path() {
    local path="$1"
    if ssh_run "test -e ${path} && echo yes || echo no" | grep -q "^yes$"; then
        log_ok  "Percorso ${path}: presente"
        return 0
    else
        log_fail "Percorso ${path}: NON trovato"
        return 1
    fi
}

check_iface() {
    local iface="$1"
    if ssh_run "ip link show ${iface} > /dev/null 2>&1 && echo yes || echo no" | grep -q "^yes$"; then
        log_ok  "Interfaccia ${iface}: presente"
        return 0
    else
        log_fail "Interfaccia ${iface}: NON trovata"
        return 1
    fi
}

# Controlla la presenza di un profilo NetworkManager
check_nm_profile() {
    local profile="$1"
    if ssh_run "nmcli con show '${profile}' > /dev/null 2>&1 && echo yes || echo no" | grep -q "^yes$"; then
        log_ok  "Profilo NM '${profile}': presente"
        return 0
    else
        log_fail "Profilo NM '${profile}': NON trovato"
        return 1
    fi
}

# Controlla la presenza di una connessione LTE attiva
check_lte() {
    local state
    state=$(ssh_run "mmcli -m 0 2>/dev/null | grep 'state' | grep -v 'power\|access\|signal\|packet' | grep -o 'connected'" || true)
    if [[ "$state" == "connected" ]]; then
        log_ok  "Connessione LTE: attiva (state=connected)"
        return 0
    else
        log_fail "Connessione LTE: NON attiva (state=${state:-sconosciuto})"
        return 1
    fi
}

check_deps() {
    local missing=()
    command -v sshpass &>/dev/null || missing+=("sshpass")
    command -v psql    &>/dev/null || missing+=("postgresql-client")
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${RED}ERRORE: pacchetti mancanti su WSL: ${missing[*]}${NC}"
        echo "  Installa con: sudo apt install ${missing[*]}"
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# MAIN
# ------------------------------------------------------------------------------

[[ $# -lt 1 ]] && usage
GW_IP="$1"

check_deps

echo ""
echo -e "${BOLD}=================================================${NC}"
echo -e "${BOLD}  Gateway Test Script${NC}"
echo -e "${BOLD}=================================================${NC}"
echo -e "  Target: ${CYAN}${GW_IP}${NC}"
echo -e "  Data:   $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- [1] Connessione SSH ---
echo -e "${BOLD}[1/7] Verifica connessione SSH...${NC}"
if ! sshpass -p "$SSH_PASS" ssh $SSH_OPTS "${SSH_USER}@${GW_IP}" "exit 0" 2>/dev/null; then
    echo -e "${RED}ERRORE: impossibile connettersi a ${GW_IP} (utente: ${SSH_USER}).${NC}"
    echo "  Verifica IP e che il gateway sia raggiungibile."
    exit 1
fi
log_ok "Connessione SSH riuscita"
echo ""

# --- [2] Tipo gateway ---
echo -e "${BOLD}[2/7] Rilevamento tipo gateway...${NC}"
HOSTNAME_REMOTE=$(ssh_run "hostname" | tr -d '[:space:]')
log_info "Hostname: ${HOSTNAME_REMOTE}"

HOSTNAME_NORM=$(echo "$HOSTNAME_REMOTE" | sed 's/[-_]//g' | tr '[:upper:]' '[:lower:]')

if echo "$HOSTNAME_NORM" | grep -q "techbase"; then
    SGW_TYPE="techbase"
elif echo "$HOSTNAME_NORM" | grep -q "edgext"; then
    SGW_TYPE="edge"
else
    echo -e "${RED}ERRORE: hostname '${HOSTNAME_REMOTE}' non riconosciuto.${NC}"
    echo "  Atteso: RefurbTechbase oppure RefurbEdgeXT"
    exit 1
fi
log_ok "Tipo rilevato: ${SGW_TYPE}"
echo ""

# --- [3] Raccolta dati ---
echo -e "${BOLD}[3/7] Raccolta dati dispositivo...${NC}"

SN=$(ssh_run "ip link show eth0 | grep ether | awk '{print \$2}' | tr -d ':'")
if [[ -z "$SN" ]]; then
    log_warn "Impossibile leggere MAC eth0 — impostato UNKNOWN"
    SN="UNKNOWN"
else
    log_ok "SN (MAC eth0): ${SN}"
fi

ICCID=$(ssh_run "mmcli -m 0 -i 0 2>/dev/null | grep iccid | awk '{print \$3}'" || true)
if [[ -z "$ICCID" ]]; then
    log_warn "ICCID non disponibile"
    ICCID="N/A"
else
    log_ok "ICCID: ${ICCID}"
fi

MODEM_MODEL=$(ssh_run "mmcli -m 0 2>/dev/null | grep -i 'model' | head -1 | sed 's/.*model: *//'" || true)
MODEM_MODEL=$(echo "$MODEM_MODEL" | sed 's/^[[:space:]]*//' | tr -d '\r')
if [[ -z "$MODEM_MODEL" ]]; then
    log_warn "Modello modem non disponibile"
    MODEM_MODEL="N/A"
else
    log_info "Modello modem: ${MODEM_MODEL}"
fi
echo ""

# --- [4/7] Pre-avvio raptor ---
echo -e "${BOLD}[4/7] Pre-avvio servizio raptor...${NC}"
RAPTOR_PRESTART=$(ssh_run "sudo systemctl start raptor.service 2>&1 && echo ok || echo fail" || true)
if [[ "$RAPTOR_PRESTART" == "ok" ]]; then
    log_ok "raptor.service avviato (o già attivo)"
else
    log_warn "Avvio raptor.service ha restituito un errore — il check successivo dirà lo stato reale"
fi
echo ""

# --- [4] Input operatore ---
echo -e "${BOLD}[5/7] Input operatore${NC}"
while true; do
    read -rp "  Inserisci Ext_SN (formato 8000XXXX oppure sole 4 cifre): " EXT_SN_INPUT
    EXT_SN_INPUT=$(echo "$EXT_SN_INPUT" | tr -d '[:space:]')

    if [[ "$EXT_SN_INPUT" =~ ^8000[0-9]{4}$ ]]; then
        EXT_SN="$EXT_SN_INPUT"
        log_ok "Ext_SN: ${EXT_SN}"
        break
    elif [[ "$EXT_SN_INPUT" =~ ^[0-9]{4}$ ]]; then
        EXT_SN="8000${EXT_SN_INPUT}"
        log_info "Completato automaticamente: ${EXT_SN}"
        break
    else
        echo -e "  ${RED}Formato non valido.${NC} Esempi: 80001234 oppure 1234"
    fi
done

# --- [4b] Input codice FR ---
echo -e "${BOLD}  Codice FR${NC}"
echo -e "  ${YELLOW}Inserisci il codice FR (formato FR + 5 cifre, es. FR12345).${NC}"
echo -e "  ${YELLOW}Premi INVIO per lasciare vuoto se il gateway non lo ha.${NC}"
while true; do
    read -rp "  FR: " FR_INPUT
    FR_INPUT=$(echo "$FR_INPUT" | tr -d '[:space:]')

    if [[ -z "$FR_INPUT" ]]; then
        FR=""
        log_warn "FR non inserito — verrà registrato come vuoto."
        break
    elif [[ "$FR_INPUT" =~ ^FR[0-9]{5}$ ]]; then
        FR="$FR_INPUT"
        log_ok "FR: ${FR}"
        break
    else
        echo -e "  ${RED}Formato non valido.${NC} Esempio: FR12345 (oppure INVIO per vuoto)"
    fi
done
echo ""

# --- [5] Controlli hardware e servizi ---
echo -e "${BOLD}[6/7] Controlli hardware e servizi (${SGW_TYPE})...${NC}"
FAIL_COUNT=0
FAIL_CODES=()

# Device specifico per tipo
if [[ "$SGW_TYPE" == "edge" ]]; then
    check_path "/dev/ttyRS485"  || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("RS485"); }
else
    check_path "/dev/ttySC0"    || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("SC0"); }
fi

# hotspot.service oneshot
check_oneshot_service "hotspot.service" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("HTSP"); }

# Servizi normali comuni
for svc in "${COMMON_SERVICES[@]}"; do
    case "$svc" in
        apnchanger)    check_service "$svc" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("APN"); } ;;
        sshd)          check_service "$svc" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("SSH"); } ;;
        raptor)        check_service "$svc" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("RAPT"); } ;;
        raptorwatchdog) check_service "$svc" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("RAPTWD"); } ;;
        *)             check_service "$svc" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("SVC:${svc}"); } ;;
    esac
done

# RS485.service oneshot solo Techbase
if [[ "$SGW_TYPE" == "techbase" ]]; then
    check_oneshot_service "RS485.service" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("RS485SVC"); }
fi

# Interfacce di rete
for iface in "${REQUIRED_IFACES[@]}"; do
    case "$iface" in
        wlan0) check_iface "$iface" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("WLAN"); } ;;
        wwan0) check_iface "$iface" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("WWAN"); } ;;
        *)     check_iface "$iface" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("IF:${iface}"); } ;;
    esac
done

# Device ttyRaptor
check_path "/dev/ttyRaptor" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("RAPTDEV"); }

# Profili NetworkManager
check_nm_profile "wwantest"     || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("NM:WTEST"); }
check_nm_profile "VODAFONE-IOT" || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("NM:VFIOT"); }

# Connessione LTE attiva
check_lte || { ((FAIL_COUNT++)) || true; FAIL_CODES+=("LTE"); }

echo ""

# --- [6] Esito e riepilogo ---
echo -e "${BOLD}[7/7] Esito test...${NC}"
if [[ $FAIL_COUNT -eq 0 ]]; then
    ESITO_TEST="OK"
    echo -e "  ${GREEN}${BOLD}ESITO: OK — tutti i controlli superati${NC}"
else
    # Costruisce stringa tipo: NOK:RAPT,LTE,RS485
    FAIL_STR=$(IFS=','; echo "${FAIL_CODES[*]}")
    ESITO_TEST="NOK:${FAIL_STR}"
    echo -e "  ${RED}${BOLD}ESITO: ${ESITO_TEST}${NC}"
fi
echo ""

echo -e "${BOLD}=================================================${NC}"
echo -e "${BOLD}  Riepilogo${NC}"
echo -e "${BOLD}=================================================${NC}"
echo -e "  SN:          ${SN}"
echo -e "  Ext_SN:      ${EXT_SN}"
echo -e "  FR:          ${FR:-(vuoto)}"
echo -e "  ICCID:       ${ICCID}"
echo -e "  Modem:       ${MODEM_MODEL}"
echo -e "  Esito_Test:  ${ESITO_TEST}"
echo -e "  sgw_type:    ${SGW_TYPE}"
echo -e "  Data:        $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

#read -rp "  Confermi l'inserimento nel database? [s/N]: " CONFIRM
#if [[ ! "$CONFIRM" =~ ^[sS]$ ]]; then
#    echo "  Inserimento annullato."
#    exit 0
#fi

# --- INSERT DB ---
echo ""
echo -e "${BOLD}Inserimento nel database...${NC}"

PGPASSWORD="$DB_PASS" psql \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -c "INSERT INTO device_tests (sn, ext_sn, iccid, esito_test, sgw_type, data, fr)
        VALUES ('${SN}', '${EXT_SN}', '${ICCID}', '${ESITO_TEST}', '${SGW_TYPE}', NOW(), '${FR:-}');"

if [[ $? -eq 0 ]]; then
    log_ok "Record inserito correttamente nel database."
else
    echo -e "${RED}ERRORE: inserimento nel database fallito.${NC}"
    exit 1
fi

echo ""
echo -e "${BOLD}=================================================${NC}"
echo -e "${GREEN}${BOLD}  Test completato.${NC}"
echo -e "${BOLD}=================================================${NC}"
echo ""
