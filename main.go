package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/user/p2p-mail-chat/cli"
	"github.com/user/p2p-mail-chat/config"
	"github.com/user/p2p-mail-chat/core"
)

func main() {
	configPath := "config.json"
	if len(os.Args) > 1 {
		configPath = os.Args[1]
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("Ошибка загрузки конфигурации: %v", err)
	}

	c, err := core.NewCore(cfg)
	if err != nil {
		log.Fatalf("Ошибка ядра: %v", err)
	}
	defer c.Stop()

	cliApp, err := cli.NewCLI(c)
	if err != nil {
		log.Fatalf("Ошибка CLI: %v", err)
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		c.Stop()
		os.Exit(0)
	}()

	cliApp.Run()
}
