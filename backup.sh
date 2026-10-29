#!/bin/bash

# Configurações
DB_NAME="nullchat"
DB_USER="postgres"
BACKUP_DIR="./backups"
DATE=$(date +"%Y-%m-%d_%H-%M-%S")
FILENAME="$BACKUP_DIR/backup_$DATE.zip"

# Cria a pasta se não existir
mkdir -p "$BACKUP_DIR"

echo "Iniciando backup em $DATE..."

# 1. Dump do banco
# Usar a senha do .env (posso exportar ela ou colocar direto aqui)
export PGPASSWORD="postgres"
pg_dump -U "$DB_USER" -h localhost -d "$DB_NAME" -F c -f "$BACKUP_DIR/db_$DATE.dump"

# 2. Compacta o dump e a pasta uploads num zip
zip -r "$FILENAME" "$BACKUP_DIR/db_$DATE.dump" "./uploads/" > /dev/null

# 3. Remove o dump solto (já tá dentro do zip)
rm "$BACKUP_DIR/db_$DATE.dump"

# 4. (Opcional) Apaga backups com mais de 30 dias para não lotar o disco
find "$BACKUP_DIR" -name "backup_*.zip" -mtime +30 -delete

echo "Backup concluído: $FILENAME"