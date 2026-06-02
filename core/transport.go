package core

import "context"

type Message struct {
	From    string
	To      string
	Subject string
	Body    string
}

// Transport абстрагирует механизм отправки и приёма сообщений.
type Transport interface {
	Send(ctx context.Context, msg Message) error
	Receive() <-chan Message
}
