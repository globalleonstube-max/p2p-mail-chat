package config

import (
	"encoding/json"
	"fmt"
	"os"
)

type Config struct {
	ImapServer      string   `json:"imap_server"`
	ImapPort        int      `json:"imap_port"`
	SmtpServer      string   `json:"smtp_server"`
	SmtpPort        int      `json:"smtp_port"`
	Email           string   `json:"email"`
	Password        string   `json:"password"`
	BootstrapEmails []string `json:"bootstrap_emails"`
	BootstrapURL    string   `json:"bootstrap_url"`
}

func Load(path string) (*Config, error) {
	cfg := &Config{
		ImapPort: 993,
		SmtpPort: 587,
	}

	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, err
		}
	}

	if v := os.Getenv("IMAP_SERVER"); v != "" {
		cfg.ImapServer = v
	}
	if v := os.Getenv("SMTP_SERVER"); v != "" {
		cfg.SmtpServer = v
	}
	if v := os.Getenv("EMAIL_USER"); v != "" {
		cfg.Email = v
	}
	if v := os.Getenv("EMAIL_PASSWORD"); v != "" {
		cfg.Password = v
	}

	if cfg.ImapServer == "" || cfg.SmtpServer == "" || cfg.Email == "" || cfg.Password == "" {
		return nil, fmt.Errorf("обязательные параметры imap_server, smtp_server, email, password не заданы")
	}
	return cfg, nil
}
