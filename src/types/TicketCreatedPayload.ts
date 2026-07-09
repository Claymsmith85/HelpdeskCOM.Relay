export interface TicketCreatedPayload {
    payload:   Payload;
    createdAt: Date;
    eventType: string;
}

export interface Payload {
    ID:                string;
    cc:                any[];
    spam:              Spam;
    events:            Event[];
    rating:            null;
    source:            Source;
    status:            string;
    tagIDs:            any[];
    shortID:           string;
    subject:           string;
    teamIDs:           string[];
    priority:          number;
    createdAt:         Date;
    createdBy:         string;
    followers:         any[];
    licenseID:         number;
    requester:         Requester;
    updatedAt:         Date;
    updatedBy:         string;
    assignment:        Assignment;
    childTickets:      any[];
    integrations:      Integrations;
    parentTicket:      null;
    createdByType:     string;
    lastMessageAt:     Date;
    detectedLanguage:  string;
    ratingRequestSent: boolean;
}

export interface Assignment {
    team:  Team;
    agent: null;
}

export interface Team {
    ID:   string;
    name: string;
}

export interface Event {
    ID:      number;
    date:    Date;
    type:    string;
    author:  Author;
    source:  Source;
    message: Message;
}

export interface Author {
    ID:   string;
    name: string;
    type: string;
}

export interface Message {
    text:         string;
    isPrivate:    boolean;
    richTextObj:  RichTextObj[];
    richTextHtml: string;
}

export interface RichTextObj {
    type:     string;
    children: Child[];
}

export interface Child {
    text: string;
}

export interface Source {
    type:           string;
    detailedSource: string;
}

export interface Integrations {
}

export interface Requester {
    name:  string;
    email: string;
}

export interface Spam {
    reason: null;
    status: boolean;
}