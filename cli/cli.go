package cli

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"

	"github.com/chzyer/readline"
	"github.com/user/p2p-mail-chat/core"
)

type CLI struct {
	core          *core.Core
	rl            *readline.Instance
	done          chan struct{}
	globalSub     chan interface{}
	outputMu      sync.Mutex
	activeContact string
	activeMu      sync.Mutex
}

func NewCLI(c *core.Core) (*CLI, error) {
	rl, err := readline.New("> ")
	if err != nil {
		return nil, err
	}
	return &CLI{
		core:      c,
		rl:        rl,
		done:      make(chan struct{}),
		globalSub: c.Subscribe(),
	}, nil
}

func (cli *CLI) Run() {
	defer func() {
		cli.core.Unsubscribe(cli.globalSub)
		cli.rl.Close()
		close(cli.done)
	}()
	go cli.globalEventHandler()

	for {
		line, err := cli.rl.Readline()
		if err == readline.ErrInterrupt {
			if len(line) == 0 {
				break
			}
			continue
		} else if err == io.EOF {
			break
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		args := strings.Fields(line)
		switch args[0] {
		case "exit":
			return
		case "status":
			cli.cmdStatus()
		case "nodes":
			cli.cmdNodes()
		case "chat":
			if len(args) < 2 {
				cli.println("используйте: chat <email>")
			} else {
				cli.startChat(args[1])
			}
		default:
			cli.println("неизвестная команда")
		}
	}
}

func (cli *CLI) setActiveContact(contact string) {
	cli.activeMu.Lock()
	defer cli.activeMu.Unlock()
	cli.activeContact = contact
}

func (cli *CLI) getActiveContact() string {
	cli.activeMu.Lock()
	defer cli.activeMu.Unlock()
	return cli.activeContact
}

func (cli *CLI) cmdStatus() {
	cli.println(fmt.Sprintf("Core daemon: running\nNodes known: %d", len(cli.core.Nodes())))
}

func (cli *CLI) cmdNodes() {
	nodes := cli.core.Nodes()
	sort.Strings(nodes)
	for _, n := range nodes {
		cli.println(n)
	}
}

func (cli *CLI) println(s string) {
	cli.outputMu.Lock()
	defer cli.outputMu.Unlock()
	_, _ = cli.rl.Write([]byte(s + "\n"))
}

func (cli *CLI) startChat(contact string) {
	cli.println(fmt.Sprintf("--- Чат с %s ---", contact))
	history := cli.core.History(contact)
	for _, msg := range history {
		prefix := "Они:"
		if msg.From == "" {
			prefix = "Вы:"
		}
		cli.println(fmt.Sprintf("[%s] %s %s", msg.Timestamp.Format("15:04"), prefix, msg.Body))
	}

	oldPrompt := cli.rl.Config.Prompt
	cli.rl.SetPrompt(contact + "> ")
	defer cli.rl.SetPrompt(oldPrompt)

	// Устанавливаем активный контакт и гарантируем его сброс при выходе
	cli.setActiveContact(contact)
	defer cli.setActiveContact("")

	chatSub := cli.core.Subscribe()
	defer cli.core.Unsubscribe(chatSub)

	stopOutput := make(chan struct{})
	var outputWg sync.WaitGroup
	outputWg.Add(1)

	go func() {
		defer outputWg.Done()
		for {
			select {
			case ev, ok := <-chatSub:
				if !ok {
					return
				}
				switch e := ev.(type) {
				case core.EventNewMessage:
					if e.Contact == contact {
						cli.println(fmt.Sprintf("[%s] Они: %s",
							e.Message.Timestamp.Format("15:04"), e.Message.Body))
					}
				case core.EventNodesUpdated:
					cli.println("[Список узлов обновлён]")
				}
			case <-stopOutput:
				return
			}
		}
	}()

	for {
		line, err := cli.rl.Readline()
		if err != nil {
			break
		}
		line = strings.TrimSpace(line)
		if line == "/exit" {
			break
		}
		if line != "" {
			err := cli.core.SendMessage(contact, line)
			if err != nil {
				cli.println("Ошибка отправки: " + err.Error())
			}
		}
	}

	close(stopOutput)
	outputWg.Wait()
}

func (cli *CLI) globalEventHandler() {
	for {
		select {
		case ev, ok := <-cli.globalSub:
			if !ok {
				return
			}
			switch e := ev.(type) {
			case core.EventNewMessage:
				// Подавляем глобальное уведомление, если находимся в чате с этим контактом
				if cli.getActiveContact() == e.Contact {
					continue
				}
				cli.println(fmt.Sprintf("[Новое сообщение от %s] %s", e.Contact, e.Message.Body))
			case core.EventNodesUpdated:
				cli.println("[Список узлов обновлён]")
			}
		case <-cli.done:
			return
		}
	}
}
