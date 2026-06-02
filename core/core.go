package core

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/user/p2p-mail-chat/config"
)

type EventNewMessage struct {
	Contact string
	Message ChatMessage
}

type EventNodesUpdated struct{}

type Core struct {
	storage   *Storage
	transport Transport
	stopCh    chan struct{}
	wg        sync.WaitGroup

	subMu sync.Mutex
	subs  map[chan interface{}]struct{}
}

func NewCore(cfg *config.Config) (*Core, error) {
	transport := NewEmailTransport(cfg)
	if err := transport.Start(); err != nil {
		return nil, err
	}
	c := &Core{
		storage:   NewStorage(),
		transport: transport,
		stopCh:    make(chan struct{}),
		subs:      make(map[chan interface{}]struct{}),
	}
	c.wg.Add(1)
	go c.processIncoming()
	go c.bootstrap(cfg)
	return c, nil
}

func (c *Core) Subscribe() chan interface{} {
	ch := make(chan interface{}, 100)
	c.subMu.Lock()
	defer c.subMu.Unlock()
	c.subs[ch] = struct{}{}
	return ch
}

func (c *Core) Unsubscribe(ch chan interface{}) {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	if _, ok := c.subs[ch]; ok {
		delete(c.subs, ch)
		close(ch)
	}
}

func (c *Core) emit(event interface{}) {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	for ch := range c.subs {
		select {
		case ch <- event:
		default:
		}
	}
}

func (c *Core) processIncoming() {
	defer c.wg.Done()
	for msg := range c.transport.Receive() {
		switch msg.Subject {
		case "[P2P-MSG]":
			cm := ChatMessage{
				From:      msg.From,
				Body:      msg.Body,
				Timestamp: time.Now(),
			}
			c.storage.AddMessage(cm)
			if !c.storage.HasNode(msg.From) {
				c.storage.AddNode(msg.From)
			}
			c.emit(EventNewMessage{Contact: msg.From, Message: cm})
		case "[P2P-JOIN]":
			if !c.storage.HasNode(msg.From) {
				c.storage.AddNode(msg.From)
				nodes := c.storage.Nodes()
				jsonList, _ := json.Marshal(nodes)
				reply := Message{
					To:      msg.From,
					Subject: "[P2P-NODES-LIST]",
					Body:    string(jsonList),
				}
				_ = c.transport.Send(context.Background(), reply)
				c.emit(EventNodesUpdated{})
			}
		case "[P2P-NODES-LIST]":
			var emails []string
			if err := json.Unmarshal([]byte(msg.Body), &emails); err == nil {
				for _, e := range emails {
					if !c.storage.HasNode(e) {
						c.storage.AddNode(e)
					}
				}
				c.emit(EventNodesUpdated{})
			}
		}
	}
}

func (c *Core) SendMessage(to, body string) error {
	cm := ChatMessage{
		To:        to,
		Body:      body,
		Timestamp: time.Now(),
	}
	c.storage.AddMessage(cm)
	msg := Message{
		To:      to,
		Subject: "[P2P-MSG]",
		Body:    body,
	}
	return c.transport.Send(context.Background(), msg)
}

func (c *Core) Nodes() []string {
	return c.storage.Nodes()
}

func (c *Core) History(contact string) []ChatMessage {
	return c.storage.MessagesWith(contact)
}

func (c *Core) Stop() {
	close(c.stopCh)
	t, ok := c.transport.(*EmailTransport)
	if ok {
		t.Stop()
	}
	c.wg.Wait()
	c.subMu.Lock()
	defer c.subMu.Unlock()
	for ch := range c.subs {
		close(ch)
	}
	c.subs = make(map[chan interface{}]struct{})
}

func (c *Core) bootstrap(cfg *config.Config) {
	if len(c.storage.Nodes()) > 0 {
		return
	}
	emails := make(map[string]bool)
	for _, e := range cfg.BootstrapEmails {
		emails[e] = true
	}
	if cfg.BootstrapURL != "" {
		resp, err := http.Get(cfg.BootstrapURL)
		if err == nil {
			defer resp.Body.Close()
			var list []string
			if json.NewDecoder(resp.Body).Decode(&list) == nil {
				for _, e := range list {
					emails[e] = true
				}
			}
		}
	}
	for email := range emails {
		if email == cfg.Email {
			continue
		}
		go func(e string) {
			msg := Message{
				To:      e,
				Subject: "[P2P-JOIN]",
				Body:    cfg.Email,
			}
			if err := c.transport.Send(context.Background(), msg); err != nil {
				log.Printf("Bootstrap JOIN to %s failed: %v", e, err)
			}
		}(email)
	}
}
