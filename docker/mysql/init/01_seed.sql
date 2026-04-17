-- Phase 1 動作確認用の最小シード。
-- porpoise_dev 以外にも適当な DB を作ってスキーマツリーのテストができるようにしておく。

CREATE DATABASE IF NOT EXISTS porpoise_sample;
GRANT ALL PRIVILEGES ON porpoise_sample.* TO 'porpoise'@'%';
FLUSH PRIVILEGES;

USE porpoise_dev;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(191) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS posts (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO users (email, display_name) VALUES
  ('alice@example.com', 'Alice'),
  ('bob@example.com',   'Bob'),
  ('carol@example.com', 'Carol')
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

INSERT INTO posts (user_id, title, body, published_at) VALUES
  (1, 'Hello, porpoise',        'first post',  NOW()),
  (1, 'Second post from Alice', 'draft',       NULL),
  (2, 'Bob writes too',          'another one', NOW());
