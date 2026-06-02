package core

import (
	"sync"
	"time"
)

type ChatMessage struct {
	From      string
	To        string
	Body      string
	Timestamp time.Time
}

type Storage struct {
	mu       sync.RWMutex
	nodes    map[string]bool
	messages map[string][]ChatMessage
}

func NewStorage() *Storage {
	return &Storage{
		nodes:    make(map[string]bool),
		messages: make(map[string][]ChatMessage),
	}
}

func (s *Storage) AddNode(email string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes[email] = true
}

func (s *Storage) HasNode(email string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.nodes[email]
}

func (s *Storage) Nodes() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]string, 0, len(s.nodes))
	for email := range s.nodes {
		list = append(list, email)
	}
	return list
}

func (s *Storage) AddMessage(msg ChatMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	contact := msg.From
	if msg.From == "" {
		contact = msg.To
	}
	s.messages[contact] = append(s.messages[contact], msg)
}

func (s *Storage) MessagesWith(contact string) []ChatMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	msgs := s.messages[contact]
	cpy := make([]ChatMessage, len(msgs))
	copy(cpy, msgs)
	return cpy
}
