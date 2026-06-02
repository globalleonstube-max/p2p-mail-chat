package core

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net/smtp"
	"strings"
	"sync"
	"time"

	"github.com/user/p2p-mail-chat/config"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	"github.com/emersion/go-message/mail"
)

type EmailTransport struct {
	cfg        *config.Config
	imapClient *client.Client
	smtpAuth   smtp.Auth
	imapMutex  sync.Mutex

	msgIn     chan Message
	sendQueue chan Message
	stopCh    chan struct{}
	wg        sync.WaitGroup

	buffers map[string]*outBuffer
	bufMu   sync.Mutex
}

type outBuffer struct {
	msgs      []Message
	timer     *time.Timer
	parent    *EmailTransport
	recipient string
}

func NewEmailTransport(cfg *config.Config) *EmailTransport {
	return &EmailTransport{
		cfg:       cfg,
		msgIn:     make(chan Message, 100),
		sendQueue: make(chan Message, 100),
		stopCh:    make(chan struct{}),
		buffers:   make(map[string]*outBuffer),
	}
}

func (t *EmailTransport) Send(ctx context.Context, msg Message) error {
	select {
	case t.sendQueue <- msg:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-t.stopCh:
		return fmt.Errorf("transport stopped")
	}
}

func (t *EmailTransport) Receive() <-chan Message {
	return t.msgIn
}

func (t *EmailTransport) Start() error {
	t.smtpAuth = smtp.PlainAuth("", t.cfg.Email, t.cfg.Password, t.cfg.SmtpServer)
	t.wg.Add(1)
	go t.senderLoop()
	t.wg.Add(1)
	go t.imapLoop()
	return nil
}

func (t *EmailTransport) Stop() {
	close(t.stopCh)
	t.wg.Wait()
	t.bufMu.Lock()
	for _, buf := range t.buffers {
		buf.flush()
	}
	t.bufMu.Unlock()
	close(t.msgIn)
}

// ------------------------------------------------------------
// IMAP приём с IDLE (потокобезопасный)
// ------------------------------------------------------------
func (t *EmailTransport) imapLoop() {
	defer t.wg.Done()
	for {
		if err := t.connectIMAP(); err != nil {
			log.Printf("IMAP connect: %v, retry in 30s", err)
			select {
			case <-t.stopCh:
				return
			case <-time.After(30 * time.Second):
				continue
			}
		}
		t.listenIMAP()
		t.imapMutex.Lock()
		if t.imapClient != nil {
			t.imapClient.Logout()
		}
		t.imapMutex.Unlock()
		select {
		case <-t.stopCh:
			return
		case <-time.After(10 * time.Second):
		}
	}
}

func (t *EmailTransport) connectIMAP() error {
	t.imapMutex.Lock()
	defer t.imapMutex.Unlock()

	addr := fmt.Sprintf("%s:%d", t.cfg.ImapServer, t.cfg.ImapPort)
	var c *client.Client
	var err error
	if t.cfg.ImapPort == 993 {
		tlsConfig := &tls.Config{ServerName: t.cfg.ImapServer}
		c, err = client.DialTLS(addr, tlsConfig)
	} else {
		c, err = client.Dial(addr)
	}
	if err != nil {
		return err
	}
	if err := c.Login(t.cfg.Email, t.cfg.Password); err != nil {
		c.Logout()
		return err
	}
	t.imapClient = c
	return nil
}

func (t *EmailTransport) listenIMAP() {
	t.imapMutex.Lock()
	if t.imapClient == nil {
		t.imapMutex.Unlock()
		return
	}
	mbox, err := t.imapClient.Select("INBOX", false)
	t.imapMutex.Unlock()
	if err != nil {
		log.Printf("IMAP select INBOX: %v", err)
		return
	}

	if mbox.Messages > 0 {
		t.fetchNewMessages()
	}

	for {
		stopIdle := make(chan struct{})
		updates := make(chan client.Update)
		t.imapMutex.Lock()
		if t.imapClient == nil {
			t.imapMutex.Unlock()
			return
		}
		t.imapClient.Updates = updates
		done := make(chan error, 1)
		go func() {
			t.imapMutex.Lock()
			cl := t.imapClient
			t.imapMutex.Unlock()
			if cl != nil {
				done <- cl.Idle(stopIdle)
			} else {
				done <- fmt.Errorf("client is nil")
			}
		}()
		t.imapMutex.Unlock()

		select {
		case <-t.stopCh:
			close(stopIdle)
			return
		case update := <-updates:
			_ = update
			close(stopIdle)
			<-done
			t.fetchNewMessages()
			t.imapMutex.Lock()
			if t.imapClient == nil {
				t.imapMutex.Unlock()
				return
			}
			_, err := t.imapClient.Select("INBOX", false)
			t.imapMutex.Unlock()
			if err != nil {
				log.Printf("IMAP reselect: %v", err)
				return
			}
		case err := <-done:
			log.Printf("IMAP idle error: %v", err)
			return
		}
	}
}

func (t *EmailTransport) fetchNewMessages() {
	t.imapMutex.Lock()
	defer t.imapMutex.Unlock()
	if t.imapClient == nil {
		return
	}

	criteria := imap.NewSearchCriteria()
	criteria.WithoutFlags = []string{imap.SeenFlag}
	uids, err := t.imapClient.Search(criteria)
	if err != nil {
		log.Printf("IMAP search: %v", err)
		return
	}
	if len(uids) == 0 {
		return
	}

	seqSet := new(imap.SeqSet)
	seqSet.AddNum(uids...)
	messages := make(chan *imap.Message, 10)
	section := imap.BodySectionName{}
	items := []imap.FetchItem{imap.FetchEnvelope, section.FetchItem()}

	go func() {
		t.imapMutex.Lock()
		cl := t.imapClient
		t.imapMutex.Unlock()
		if cl != nil {
			if err := cl.Fetch(seqSet, items, messages); err != nil {
				log.Printf("IMAP fetch: %v", err)
			}
		}
	}()

	var toDelete []uint32
	for msg := range messages {
		subject := ""
		if msg.Envelope != nil {
			subject = msg.Envelope.Subject
		}
		from := ""
		if msg.Envelope != nil && len(msg.Envelope.From) > 0 {
			from = msg.Envelope.From[0].Addr()
		}
		body := extractBody(msg)

		switch {
		case strings.HasPrefix(subject, "[P2P-MSG]"):
			t.handleMsg(from, body)
			toDelete = append(toDelete, msg.Uid)
		case strings.HasPrefix(subject, "[P2P-JOIN]"):
			t.handleJoin(from)
			toDelete = append(toDelete, msg.Uid)
		case strings.HasPrefix(subject, "[P2P-NODES-LIST]"):
			t.handleNodesList(body)
			toDelete = append(toDelete, msg.Uid)
		}
	}

	if len(toDelete) > 0 && t.imapClient != nil {
		delSet := new(imap.SeqSet)
		delSet.AddNum(toDelete...)
		item := imap.FormatFlagsOp(imap.AddFlags, true)
		flags := []interface{}{imap.DeletedFlag}
		if err := t.imapClient.Store(delSet, item, flags, nil); err != nil {
			log.Printf("IMAP delete flag: %v", err)
		}
		if err := t.imapClient.Expunge(nil); err != nil {
			log.Printf("IMAP expunge: %v", err)
		}
	}
}

// extractBody разбирает MIME-тело и возвращает text/plain.
func extractBody(msg *imap.Message) string {
	if msg == nil || msg.Body == nil {
		return ""
	}
	var buf bytes.Buffer
	for _, literal := range msg.Body {
		if literal != nil {
			_, _ = io.Copy(&buf, literal)
		}
	}
	if buf.Len() == 0 {
		return ""
	}

	mr, err := mail.CreateReader(&buf)
	if err != nil {
		return buf.String()
	}
	defer mr.Close()

	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue
		}
		switch h := p.Header.(type) {
		case *mail.InlineHeader:
			ct, _, _ := h.ContentType()
			if strings.HasPrefix(ct, "text/plain") {
				bodyBytes, _ := io.ReadAll(p.Body)
				return string(bodyBytes)
			}
		}
	}
	return ""
}

func (t *EmailTransport) handleMsg(from, body string) {
	t.msgIn <- Message{
		From:    from,
		Subject: "[P2P-MSG]",
		Body:    body,
	}
}

func (t *EmailTransport) handleJoin(from string) {
	t.msgIn <- Message{
		From:    from,
		Subject: "[P2P-JOIN]",
		Body:    "",
	}
}

func (t *EmailTransport) handleNodesList(body string) {
	t.msgIn <- Message{
		From:    "bootstrap",
		Subject: "[P2P-NODES-LIST]",
		Body:    body,
	}
}

// ------------------------------------------------------------
// SMTP отправка с буферизацией
// ------------------------------------------------------------
func (t *EmailTransport) senderLoop() {
	defer t.wg.Done()
	for {
		select {
		case msg := <-t.sendQueue:
			if msg.Subject == "[P2P-MSG]" {
				t.enqueueBuffered(msg)
			} else {
				go t.sendImmediate(msg)
			}
		case <-t.stopCh:
			return
		}
	}
}

func (t *EmailTransport) enqueueBuffered(msg Message) {
	t.bufMu.Lock()
	defer t.bufMu.Unlock()
	buf, ok := t.buffers[msg.To]
	if !ok {
		buf = &outBuffer{
			parent:    t,
			recipient: msg.To,
		}
		t.buffers[msg.To] = buf
	}
	buf.msgs = append(buf.msgs, msg)
	if buf.timer != nil {
		buf.timer.Stop()
	}
	buf.timer = time.AfterFunc(2*time.Second, func() {
		t.bufMu.Lock()
		delete(t.buffers, msg.To)
		t.bufMu.Unlock()
		buf.flush()
	})
}

func (buf *outBuffer) flush() {
	if len(buf.msgs) == 0 {
		return
	}
	var bodies []string
	for _, m := range buf.msgs {
		bodies = append(bodies, m.Body)
	}
	combinedBody := strings.Join(bodies, "\n---\n")
	msg := Message{
		To:      buf.recipient,
		Subject: "[P2P-MSG]",
		Body:    combinedBody,
	}
	buf.parent.sendImmediate(msg)
}

func (t *EmailTransport) sendImmediate(msg Message) {
	err := t.smtpSend(msg)
	if err != nil {
		log.Printf("SMTP send error to %s: %v", msg.To, err)
	}
}

func (t *EmailTransport) smtpSend(msg Message) error {
	from := t.cfg.Email
	header := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s",
		from, msg.To, msg.Subject, msg.Body)
	return t.dialAndSend(from, []string{msg.To}, []byte(header))
}

func (t *EmailTransport) dialAndSend(from string, to []string, msg []byte) error {
	addr := fmt.Sprintf("%s:%d", t.cfg.SmtpServer, t.cfg.SmtpPort)
	if t.cfg.SmtpPort == 465 {
		tlsConfig := &tls.Config{ServerName: t.cfg.SmtpServer}
		conn, err := tls.Dial("tcp", addr, tlsConfig)
		if err != nil {
			return err
		}
		smtpClient, err := smtp.NewClient(conn, t.cfg.SmtpServer)
		if err != nil {
			conn.Close()
			return err
		}
		defer smtpClient.Close()
		if err = smtpClient.Auth(t.smtpAuth); err != nil {
			return err
		}
		if err = smtpClient.Mail(from); err != nil {
			return err
		}
		for _, rcpt := range to {
			if err = smtpClient.Rcpt(rcpt); err != nil {
				return err
			}
		}
		w, err := smtpClient.Data()
		if err != nil {
			return err
		}
		_, err = w.Write(msg)
		if err != nil {
			return err
		}
		err = w.Close()
		if err != nil {
			return err
		}
		return smtpClient.Quit()
	}
	return smtp.SendMail(addr, t.smtpAuth, from, to, msg)
}
